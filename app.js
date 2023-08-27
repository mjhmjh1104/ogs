const express = require('express');
const session = require('express-session');
const app = express();
const http = require('http').Server(app);
const path = require('path');
const bodyParser = require('body-parser');
const { Worker } = require('worker_threads');
const fsStream = require('fs');
const fs = fsStream.promises;
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const { sqlpw, sessSecret, salt } = require('./config.json');
const io = require('socket.io')(http);
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const fileUpload = require("express-fileupload");
const decompress = require('decompress');
const archiver = require('archiver');

var sql = null;

// List of connected auto-refreshing pages
var socketList = { };
var idSockets = { };
var checkerSocket = { };
var gradingSocket = { };
var testSocket = { };

// Queue storing submission IDs
var queue = [ ];
var queries = [ ];

var workers = [ ];

function genID() {
    // Generates random hex ID
    return crypto.randomBytes(32).toString('hex');
}

function tryGrading() {
    if (queue.length == 0) {
        // Nothing to grade
        return;
    }
    for (idx in workers) {
        if (workers[idx].busy == false) {
            workers[idx].busy = true;
            workers[idx].machine.postMessage({
                data: 'grade',
                content: queue[0]
            });
            queue.shift();
            if (queue.length == 0) {
                // Done
                return;
            }
        }
    }
    // No free worker
}

function inappropriate(x) {
    return x.includes('"') || x.includes('/') || x === '.' || x === '..';
}

async function mkdir(path) {
    try {
        await fs.access(path);
    } catch (e) {
        await fs.mkdir(path, {
            recursive: true
        });
    }
}

async function upload(file, path) {
    await new Promise(function (resolve, reject) {
        file.mv(path, function (err) {
            if (err) throw new Error ('File upload failed');
            resolve();
        });
    });
}

app.set('view engine', 'ejs');
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({
    extended: true
}));
app.use(express.json());
app.use(fileUpload({
    createParentPath: true
}));

app.use(session({
    key: 'auth',
    secret: sessSecret,
    resave: false,
    saveUninitialized: true,
    cookie: {
        expires: 1000 * 60 * 60 * 24 * 7
    }
}));
app.use(cookieParser());

const problemsPerPage = 100;
const submissionsPerPage = 100;
const historyPerPage = 100;

app.get('/', async function (req, res) {
    var page = 1;
    if (req.query.page !== undefined && parseInt(req.query.page) == req.query.page && req.query.page >= 1) page = parseInt(req.query.page);
    const cnt = (await sql.query(`SELECT COUNT(1) FROM problems;`))[0][0]['COUNT(1)'];
    const [ rows, fields ] = await sql.query(`SELECT * FROM problems ORDER BY num LIMIT ${(page - 1) * problemsPerPage}, ${problemsPerPage};`);
    return res.render('main', {
        problems: rows,
        user: req.session.auth,
        page: page,
        pages: ~~((cnt + problemsPerPage - 1) / problemsPerPage)
    });
});

app.get('/signin', function (req, res) {
    if (req.session.auth) return res.redirect('/');
    res.render('login', {
        username: '',
        error: ''
    });
});

app.post('/signin', async function (req, res) {
    if (req.session.auth) return res.redirect('/');
    const rows = (await sql.query(`SELECT password, admin FROM users WHERE user = ${mysql.escape(req.body.user)}`))[0];
    if (rows.length == 0) return res.render('login', {
        username: req.body.user,
        error: 'Invalid username or password'
    });
    if (await bcrypt.compare(req.body.password, rows[0].password)) {
        req.session.auth = {
            user: req.body.user,
            admin: rows[0].admin
        };
        req.session.save();
        res.redirect('/');
    } else res.render('login', {
        username: req.body.user,
        error: 'Invalid username or password'
    });
});

app.get('/signout', function (req, res) {
    if (req.session.auth) req.session.destroy();
    res.redirect('/');
});

app.get('/register', function (req, res) {
    if (req.session.auth) return res.redirect('/');
    res.render('register', {
        username: '',
        error: ''
    });
});

app.post('/register', async function (req, res) {
    if (req.session.auth) return res.redirect('/');
    if (req.body.user.length == 0) {
        return res.render('register', {
            username: req.body.user,
            error: 'Invalid username'
        });
    }
    if (req.body.password !== req.body.passwordCheck) {
        return res.render('register', {
            username: req.body.user,
            error: 'Password does not match'
        });
    }
    if (req.body.password.length == 0) {
        return res.render('register', {
            username: req.body.user,
            error: 'Password cannot be empty'
        });
    }
    if ((await sql.query(`SELECT COUNT(1) FROM users WHERE user = ${mysql.escape(req.body.user)}`))[0][0]['COUNT(1)'] >= 1) {
        return res.render('register', {
            username: req.body.user,
            error: 'Invalid username'
        });
    }
    const hashedPassword = await bcrypt.hash(req.body.password, salt);
    await sql.query(`INSERT INTO users (user, password) VALUES (${mysql.escape(req.body.user)}, ${mysql.escape(hashedPassword)})`);
    res.redirect('/signin');
});

app.get('/users', async function (req, res) {
    const rows = (await sql.query(`SELECT cnt, user, registerDate, admin FROM users`))[0];
    return res.render('users', {
        users: rows,
        user: req.session.auth
    });
});

app.post('/users/:id/admin', async function (req, res) {
    if (!req.session.auth) return res.redirect('/users');
    if (!req.session.auth.admin) res.redirect('/users');
    const [ rows, fields ] = await sql.query(`UPDATE users SET admin = NOT admin WHERE user = ${mysql.escape(req.params.id)};`);
    res.redirect('/users');
});

app.post('/users/:id/delete', async function (req, res) {
    if (!req.session.auth) return res.redirect('/users');
    if (!req.session.auth.admin) res.redirect('/users');
    const [ rows, fields ] = await sql.query(`DELETE FROM users WHERE user = ${mysql.escape(req.params.id)};`);
    res.redirect('/users');
});

app.get('/detail/:id', async function (req, res) {
    const [ rows, fields ] = await sql.query(`SELECT cnt, id, user, result, lang, marks, problem, time, memory, submitDate FROM submissions LEFT JOIN problems ON submissions.problem = problems.num WHERE id = ${mysql.escape(req.params.id)};`);
    if (rows.length <= 0) return res.send('Not Found');
    const problem = rows[0].problem;
    var code = { };
    var grading = { };
    try {
        grading = JSON.parse(await fs.readFile(`archive/${problem}/grading.json`));
    } catch (e) { }
    var sumPoint = 0;
    if (grading.subtask) for (var i = 0; i < grading.subtask.length; i++) sumPoint += parseInt(grading.subtask[i].marks);
    var k = -1;
    for (var i = 0; i < grading.languages.length; i++) if (grading.languages[i].lang === rows[0].lang) k = i;
    if (k != -1 && grading.languages[k].submittings.length <= 0) {
        var languages = [ ];
        try {
            languages = JSON.parse(await fs.readFile('grading/languages.json'));
        } catch (e) { }
        var l = -1;
        for (var j = 0; j < languages.length; j++) if (languages[i].id === grading.languages[k].lang) l = j;
        if (l != -1) grading.languages[k].submittings = languages[l].submittings;
    }
    if (k != -1) for (var i = 0; i < grading.languages[k].submittings.length; i++) {
        const name = grading.languages[k].submittings[i];
        code[name] = (await fs.readFile(`grading/submissions/${req.params.id}-${name}`)).toString();
    }
    const [ rows2, fields2 ] = await sql.query(`SELECT subtask, result, marks, time, walltime, mem FROM subtasks WHERE id = ${mysql.escape(req.params.id)} ORDER BY subtask`);
    var subtasks = rows2;
    var tl = Infinity, ml = Infinity;
    for (var i = 0; i < subtasks.length; i++) {
        subtasks[i].marks *= grading.subtask[parseInt(subtasks[i].subtask) - 1].marks;
        subtasks[i].max = grading.subtask[parseInt(subtasks[i].subtask) - 1].marks;
    }
    var subTl = [ ], subMl = [ ];
    for (var i = 0; i < grading.subtask.length; i++) {
        subTl.push(grading.subtask[i].tl);
        subMl.push(grading.subtask[i].ml);
        tl = Math.min(tl, grading.subtask[i].tl);
        ml = Math.min(ml, grading.subtask[i].ml);
    }
    subTl.unshift(tl);
    subMl.unshift(ml);
    var cpMessage = '';
    try {
        cpMessage = await fs.readFile(`grading/messages/${req.params.id}`);
    } catch (e) { }
    return res.render('submission', {
        code: code,
        submission: rows[0],
        user: req.session.auth,
        getResult: getResult,
        grading: grading,
        subtasks: subtasks,
        max: sumPoint,
        log: cpMessage,
        subTl: subTl,
        subMl: subMl
    });
});

app.post('/detail/:id/delete', async function (req, res) {
    return res.redirect(`/detail/${req.params.id}`);
    const [ rows, fields ] = await sql.query(`SELECT user, result, problem FROM submissions WHERE id = ${mysql.escape(req.params.id)};`);
    if (rows.length <= 0) return res.send('Not Found');
    if (!req.session.auth) return res.redirect(`/detail/${req.params.id}`);
    if (!req.session.auth.admin && req.session.auth.user !== rows[0].user) return req.redirect(`/detail/${req.params.id}`);
    await sql.query(`DELETE FROM submissions WHERE id = ${mysql.escape(req.params.id)};`);
    if (rows[0].result === 'AC') await sql.query(`UPDATE problems SET correctCnt = correctCnt - 1 WHERE num = ${mysql.escape(rows[0].problem)};`);
    await sql.query(`UPDATE problems SET submitCnt = submitCnt - 1 WHERE num = ${mysql.escape(rows[0].problem)};`);
    res.redirect(`/submissions/${rows[0].problem}`)
});

app.get('/view/:num', async function (req, res) {
    var num = req.params.num;
    var redr = '';
    const [ rows2, fields2 ] = await sql.query(`SELECT href FROM redirections WHERE num = ${mysql.escape(req.params.num)}`);
    if (rows2.length > 0) {
        num = rows2[0].href;
        redr = req.params.num;
    }
    const [ rows, fields ] = await sql.query(`SELECT submitCnt, correctCnt FROM problems WHERE num = ${mysql.escape(num)}`);
    if (rows.length <= 0) return res.render('nothing', {
        num: num,
        user: req.session.auth
    });
    const info = JSON.parse(await fs.readFile(`archive/${num}/info.json`));
    var examples = [ ];
    try {
        examples = JSON.parse(await fs.readFile(`archive/${num}/examples.json`));
    } catch (e) { }
    var grading = { };
    try {
        grading = JSON.parse(await fs.readFile(`archive/${req.params.num}/grading.json`));
    } catch (e) { }
    var contents = [ ];
    for (idx in info.versions) {
        const obj = info.versions[idx];
        if (obj.type === 'md') {
            var content = (await fs.readFile(`archive/${num}/descriptions/${obj.filename}`)).toString();
            var title = info.title;
            const matches = [ ...content.matchAll('\\[\\[title:.*\\]\\]') ];
            if (matches.length > 0) {
                title = matches[0].toString().substr(2, matches[0].toString().length - 4).split(':')[1];
                content = content.replace(matches[0].toString(), '');
            }
            contents.push({
                content: replaceExamples(content, examples),
                type: obj.type,
                lang: obj.lang,
                name: obj.name,
                title: title
            });
        } else if (obj.type === 'pdf') {
            contents.push({
                content: obj.path,
                type: obj.type,
                lang: obj.lang,
                name: obj.name,
                title: info.title,
                provide: obj.provide
            });
        }
    }
    var tl = Infinity, ml = Infinity;
    if (grading.subtask) for (var i = 0; i < grading.subtask.length; i++) {
        tl = Math.min(tl, grading.subtask[i].tl);
        ml = Math.min(ml, grading.subtask[i].ml);
    }
    return res.render('problem', {
        redr: redr,
        num: num,
        info: info,
        infoSql: rows[0],
        contents: contents,
        user: req.session.auth,
        gradable: grading.gradable,
        tl: tl,
        ml: ml
    });
});

app.get('/view/:num/providing/*', async function (req, res) {
    var pt = req.params[0] ? req.params[0] : '';
    if (!pt) return res.send('Not Found');
    res.sendFile(pt, {
        root: path.join(__dirname, `archive/${req.params.num}/providing`)
    });
});

app.get('/add/:num', async function (req, res) {
    if (!req.session.auth) return res.redirect(`/view/${req.params.num}`);
    if (!req.session.auth.admin) return res.redirect(`/view/${req.params.num}`);
    const [ rows, fields ] = await sql.query(`SELECT COUNT(1) FROM problems WHERE num = ${mysql.escape(req.params.num)}`);
    if (rows[0]['COUNT(1)'] > 0) return res.redirect(`/view/${req.params.num}`);
    const [ rows2, fields2 ] = await sql.query(`SELECT COUNT(1) FROM redirections WHERE num = ${mysql.escape(req.params.num)}`);
    if (rows2[0]['COUNT(1)'] > 0) return res.redirect(`/view/${req.params.num}`);
    if (inappropriate(req.params.num)) return res.redirect('/');
    res.render('add', {
        error: '',
        num: req.params.num,
        data: {}
    });
});

app.post('/add/:num', async function (req, res) {
    if (!req.session.auth) return res.redirect(`/view/${req.params.num}`);
    if (!req.session.auth.admin) return res.redirect(`/view/${req.params.num}`);
    const [ rows, fields ] = await sql.query(`SELECT COUNT(1) FROM problems WHERE num = ${mysql.escape(req.params.num)}`);
    if (rows[0]['COUNT(1)'] > 0) return res.redirect(`/view/${req.params.num}`);
    if (inappropriate(req.params.num)) return res.redirect('/');
    if (req.body.type === 'problem') {
        if (!req.body.title) return res.render('add', {
            error: 'Title is empty',
            num: req.params.num,
            data: req.body
        });
        await sql.query(`INSERT INTO problems (num, title) VALUES (${mysql.escape(req.params.num)}, ${mysql.escape(req.body.title)});`);
        await saveProblem(req.params.num, {
            title: req.body.title
        });
        await exec(`mkdir "archive/${req.params.num}"`);
        await fs.writeFile(`archive/${req.params.num}/info.json`, JSON.stringify({
            title: req.body.title,
            providing: [ ]
        }));
        await addHistory(req.params.num, req.session.auth.user, 'CRTPRB', null, {
            before: { },
            after: {
                type: 'problem',
                info: {
                    title: req.body.title,
                    providing: [ ]
                }
            }
        });
        return res.redirect(`/view/${req.params.num}`);
    } else if (req.body.type === 'redirection') {
        if (inappropriate(req.body.href)) return res.render('add', {
            error: 'Href is prohibited',
            num: req.params.num,
            data: req.body
        });
        if (!req.body.href) return res.render('add', {
            error: 'Href is empty',
            num: req.params.num,
            data: req.body
        });
        await sql.query(`INSERT INTO redirections (num, href) VALUES (${mysql.escape(req.params.num)}, ${mysql.escape(req.body.href)});`);
        await saveRedirection(req.params.num, {
            href: req.body.href
        });
        await addHistory(req.params.num, req.session.auth.user, 'CRTRDR', req.body.href, {
            before: { },
            after: {
                type: 'redirection',
                info: {
                    href: req.body.href
                }
            }
        });
        return res.redirect('/redirections');
    } else return res.render('add', {
        error: 'Choose problem type',
        num: req.params.num,
        data: req.body
    });
});

app.get('/edit/:num', async function (req, res) {

    //const [ rows, fields ] = await sql.query(`SELECT file, description FROM checkers`);
});

app.post('/delete/:num', async function (req, res) {
    if (!req.session.auth) return res.redirect(`/view/${req.params.num}`);
    if (!req.session.auth.admin) return res.redirect(`/view/${req.params.num}`);
    const [ rows, fields ] = await sql.query(`SELECT COUNT(1) FROM problems WHERE num = ${mysql.escape(req.params.num)};`);
    if (rows[0]['COUNT(1)'] <= 0) return res.send('Not Found');
    await sql.query(`DELETE FROM problems WHERE num = ${mysql.escape(req.params.num)};`);
    await removeProblem(req.params.num);
    await exec(`mv "archive/${req.params.num}" "archive/${genID()}"`);
    await addHistory(req.params.num, req.session.auth.user, 'RMVPRB', null, {
        before: {
            type: 'problem'
        },
        after: { }
    });
    res.redirect('/');
});

app.get('/submit/:num', async function (req, res) {
    if (!req.session.auth) return res.redirect('/signin');
    const [ rows, fields ] = await sql.query(`SELECT title FROM problems WHERE num = ${mysql.escape(req.params.num)};`);
    if (rows.length <= 0) {
        const [ rows2, fields2 ] = await sql.query(`SELECT href FROM redirections WHERE num = ${mysql.escape(req.params.num)};`);
        if (rows2.length > 0) return res.redirect(`/submit/${rows2[0].href}`);
        return res.send('Not Found');
    }
    var grading = { };
    try {
        grading = JSON.parse(await fs.readFile(`archive/${req.params.num}/grading.json`));
    } catch (e) { }
    if (!grading.gradable) return res.redirect(`/view/${req.params.num}`);
    var languages = [ ];
    try {
        languages = JSON.parse(await fs.readFile('grading/languages.json'));
    } catch (e) { }
    for (idx in grading.languages) {
        const id = grading.languages[idx].lang;
        for (var j = 0; j < languages.length; j++) if (languages[j].id === id) {
            grading.languages[idx].langName = languages[j].name;
            if (grading.languages[idx].submittings.length <= 0) grading.languages[idx].submittings = languages[j].submittings;
            if (grading.languages[idx].args.length <= 0) grading.languages[idx].args = languages[j].args;
        }
    }
    return res.render('submit', {
        error: '',
        stderr: '',
        message: '',
        num: req.params.num,
        title: rows[0].title,
        user: req.session.auth,
        grading: grading,
        data: {
            id: genID()
        }
    });
});

app.get('/submissions', async function (req, res) {
    var page = 1;
    if (req.query.page !== undefined && parseInt(req.query.page) == req.query.page && req.query.page >= 1) page = parseInt(req.query.page);
    const cnt = (await sql.query(`SELECT COUNT(1) FROM submissions;`))[0][0]['COUNT(1)'];
    const [ rows, fields ] = await sql.query(`SELECT cnt, id, user, result, problem, time, memory, submitDate, title FROM submissions LEFT JOIN problems ON submissions.problem = problems.num ORDER BY cnt DESC LIMIT  ${(page - 1) * submissionsPerPage}, ${submissionsPerPage};`);
    return res.render('submissions', {
        submissions: rows,
        getResult: getResult,
        page: page,
        pages: ~~((cnt + submissionsPerPage - 1) / submissionsPerPage)
    });
})

app.get('/submissions/:num', async function (req, res) {
    var page = 1;
    if (req.query.page !== undefined && parseInt(req.query.page) == req.query.page && req.query.page >= 1) page = parseInt(req.query.page);
    const [ rows, fields ] = await sql.query(`SELECT title FROM problems WHERE num=${mysql.escape(req.params.num)};`);
    if (rows.length <= 0) {
        const [ rows2, fields2 ] = await sql.query(`SELECT href FROM redirections WHERE num = ${mysql.escape(req.params.num)}`);
        if (rows2.length > 0) return res.redirect(`/submissions/${rows2[0].href}`);
        return res.send('Not Found');
    }
    const cnt = (await sql.query(`SELECT COUNT(1) FROM submissions WHERE problem = ${mysql.escape(req.params.num)}`))[0][0]['COUNT(1)'];
    const [ rows2, fields2 ] = await sql.query(`SELECT cnt, id, user, result, problem, time, memory, submitDate FROM submissions WHERE problem = ${mysql.escape(req.params.num)} ORDER BY cnt DESC LIMIT ${(page - 1) * submissionsPerPage}, ${submissionsPerPage};`);
    return res.render('list', {
        title: rows[0].title,
        num: req.params.num,
        submissions: rows2,
        getResult: getResult,
        page: page,
        pages: ~~((cnt + submissionsPerPage - 1) / submissionsPerPage)
    });
});

app.post('/submit/:num', async function (req, res) {
    if (!req.session.auth) return res.redirect('/signin');
    const [ rows, fields ] = await sql.query(`SELECT COUNT(1) FROM problems WHERE num = ${mysql.escape(req.params.num)};`);
    if (rows[0]['COUNT(1)'] <= 0) return res.send('Not Found');
    var grading = { };
    try {
        grading = JSON.parse(await fs.readFile(`archive/${req.params.num}/grading.json`));
    } catch (e) { }
    if (!grading.gradable) return res.redirect(`/view/${req.params.num}`);
    var languages = [ ];
    try {
        languages = JSON.parse(await fs.readFile('grading/languages.json'));
    } catch (e) { }
    var k = -1;
    for (var i = 0; i < languages.length; i++) if (languages[i].id === req.body.lang) k = i;
    if (k == -1) return res.redirect(`/submit/${req.params.num}`);
    for (idx in grading.languages) {
        const id = grading.languages[idx].lang;
        for (var j = 0; j < languages.length; j++) if (languages[j].id === id) {
            grading.languages[idx].langName = languages[j].name;
            if (grading.languages[idx].submittings.length <= 0) grading.languages[idx].submittings = languages[j].submittings;
            if (grading.languages[idx].args.length <= 0) grading.languages[idx].args = languages[j].args;
        }
    }
    k = -1;
    for (var i = 0; i < grading.languages.length; i++) if (grading.languages[i].lang === req.body.lang) k = i;
    if (k == -1) return res.redirect(`/submit/${req.params.num}`);
    const args = grading.languages[k].args;
    const submittings = grading.languages[k].submittings;
    const id = genID();
    for (var i = 0; i < submittings.length; i++) {
        if (req.files && req.files[`upload-${submittings[i]}`]) await upload(req.files[`upload-${submittings[i]}`], `grading/submissions/${id}-${submittings[i]}`);
        else await fs.writeFile(`grading/submissions/${id}-${submittings[i]}`, req.body[`code-${submittings[i]}`].replace(/\r/g, ''));
    }
    if (grading.languages[k].test && req.body.force !== 'true') {
        if (testSocket[req.body.id] === undefined) testSocket[req.body.id] = { };
        testSocket[req.body.id].to = id;
        queue.push({
            type: 'test',
            filename: id,
            time: Date.now(),
            user: req.session.auth.user,
            problem: req.params.num,
            grading: grading,
            lang: req.body.lang,
            args: args,
            submittings: submittings
        });
        tryGrading();
        return res.json({
            type: 'done',
            message: 'Compiling...'
        });
    } else {
        queue.push({
            type: 'execute',
            filename: id,
            time: Date.now(),
            user: req.session.auth.user,
            problem: req.params.num,
            grading: grading,
            lang: req.body.lang,
            args: args,
            submittings: submittings
        });
        await sql.query(`INSERT INTO submissions (id, user, problem, lang) VALUES (${mysql.escape(id)}, ${mysql.escape(req.session.auth.user)}, ${mysql.escape(req.params.num)}, ${mysql.escape(req.body.lang)})`);
        await sql.query(`UPDATE problems SET submitCnt = submitCnt + 1 WHERE num = ${mysql.escape(req.params.num)};`);
        tryGrading();
        res.redirect(`/detail/${id}`);
    }
});

app.get('/checkers', async function (req, res) {
    if (!req.session.auth) return res.redirect('/signin');
    if (!req.session.auth.admin) return res.redirect('/');
    const [ rows, fields ] = await sql.query(`SELECT file, description FROM checkers;`);
    res.render('checkers', {
        checkers: rows,
        user: req.session.auth
    });
});

app.get('/checkers/view/:file', async function (req, res) {
    if (!req.session.auth) return res.redirect('/signin');
    if (!req.session.auth.admin) return res.redirect('/');
    const [ rows, fields ] = await sql.query(`SELECT file, description FROM checkers WHERE file = ${mysql.escape(req.params.file)};`);
    if (rows.length <= 0) return res.send('Not Found');
    const code = await fs.readFile(`grading/checkers/${req.params.file}.cpp`);
    res.render('checker', {
        checker: rows[0],
        code: code.toString(),
        user: req.session.auth
    });
});

app.get('/checkers/add', async function (req, res) {
    if (!req.session.auth) return res.redirect('/signin');
    if (!req.session.auth.admin) return res.redirect('/');
    res.render('checkerAdd', {
        data: {}
    });
});

app.get('/checkers/edit/:idx', async function (req, res) {
    if (!req.session.auth) return res.redirect('/signin');
    if (!req.session.auth.admin) return res.redirect('/');
    const [ rows, fields ] = await sql.query(`SELECT description FROM checkers WHERE file = ${mysql.escape(req.params.idx)}`);
    if (rows.length <= 0) return res.redirect('/checkers');
    const code = await fs.readFile(`grading/checkers/${req.params.idx}.cpp`);
    res.render('checkerAdd', {
        data: {
            edit: true,
            file: req.params.idx,
            description: rows[0].description,
            code: code
        }
    });
});

app.post('/checkers/add', async function (req, res) {
    if (!req.session.auth) return res.json({
        type: 'redirect',
        url: '/signin'
    });
    if (!req.session.auth.admin) return res.json({
        type: 'redirect',
        url: '/'
    });
    if (inappropriate(req.body.file)) return res.json({
        type: 'error',
        error: 'Filename is prohibited'
    });
    if (req.body.file.length <= 0) return res.json({
        type: 'error',
        error: 'Filename is empty'
    });
    const [ rows, fields ] = await sql.query(`SELECT COUNT(1) FROM checkers WHERE file = ${mysql.escape(req.body.file)}`);
    if (rows[0]['COUNT(1)'] > 0 && req.body.edit !== 'true') return res.json({
        type: 'error',
        error: 'File already exists'
    });
    await fs.writeFile(`grading/checkers/${req.body.file}.cpp`, req.body.code.replace(/\r/g, ''));
    queue.push({
        type: 'checker',
        filename: req.body.file,
        description: req.body.description,
        edit: req.body.edit
    });
    tryGrading();
    return res.json({
        type: 'done',
        message: 'Compiling...'
    });
});

app.post('/checkers/delete/:file', async function (req, res) {
    if (!req.session.auth) return res.redirect('/signin');
    if (!req.session.auth.admin) return res.redirect('/');
    if (inappropriate(req.params.file)) return res.redirect(`/checkers`);
    await sql.query(`DELETE FROM checkers WHERE file = ${mysql.escape(req.params.file)};`);
    await exec(`yes | rm -rf "grading/checkers/${req.params.file}.cpp"`);
    await removeChecker(req.params.file);
    res.redirect('/checkers');
});

app.get('/redirections', async function (req, res) {
    const [ rows, fields ] = await sql.query(`SELECT num, href FROM redirections;`);
    res.render('redirections', {
        redirections: rows,
        user: req.session.auth
    });
});

app.post('/redirections/:num/delete', async function (req, res) {
    if (!req.session.auth) return res.redirect('/signin');
    if (!req.session.auth.admin) return res.redirect(`/view/${req.params.num}`);
    await sql.query(`DELETE FROM redirections WHERE num = ${mysql.escape(req.params.num)};`);
    await removeProblem(req.params.num);
    await addHistory(req.params.num, req.session.auth.user, 'RMVRDR', null, {
        before: {
            type: 'redirection'
        },
        after: { }
    });
    res.redirect('/redirections');
});

app.get('/history/:num', async function (req, res) {
    var page = 1;
    if (req.query.page !== undefined && parseInt(req.query.page) == req.query.page && req.query.page >= 1) page = parseInt(req.query.page);
    const cnt = (await sql.query(`SELECT COUNT(1) FROM histories WHERE problem = ${mysql.escape(req.params.num)};`))[0][0]['COUNT(1)'];
    const [ rows, fields ] = await sql.query(`SELECT cnt, problem, user, type, arg, date FROM histories WHERE problem = ${mysql.escape(req.params.num)} ORDER BY cnt DESC LIMIT ${(page - 1) * historyPerPage}, ${historyPerPage};`);
    res.render('history', {
        num: req.params.num,
        history: rows,
        getHistory: getHistory,
        page: page,
        pages: ~~((cnt + submissionsPerPage - 1) / submissionsPerPage)
    });
});

app.get('/description/:num', async function (req, res) {
    if (!req.session.auth) return res.redirect('/signin');
    if (!req.session.auth.admin) return res.redirect(`/view/${req.params.num}`);
    const [ rows, fields ] = await sql.query(`SELECT COUNT(1) FROM problems WHERE num = ${mysql.escape(req.params.num)};`);
    if (rows[0]['COUNT(1)'] <= 0) return res.redirect('/');
    const info = JSON.parse(await fs.readFile(`archive/${req.params.num}/info.json`));
    res.render('descriptions', {
        num: req.params.num,
        descriptions: info.versions
    });
});

app.get('/solution/:num', async function (req, res) {
    if (!req.session.auth) return res.redirect('/signin');
    if (!req.session.auth.admin) return res.redirect(`/view/${req.params.num}`);
    const [ rows, fields ] = await sql.query(`SELECT COUNT(1) FROM problems WHERE num = ${mysql.escape(req.params.num)};`);
    if (rows[0]['COUNT(1)'] <= 0) return res.redirect('/');
    const info = JSON.parse(await fs.readFile(`archive/${req.params.num}/info.json`));
    res.render('solutions', {
        num: req.params.num,
        solutions: info.solutions
    });
});

app.get('/description/:num/add', async function (req, res) {
    if (!req.session.auth) return res.redirect('/signin');
    if (!req.session.auth.admin) return res.redirect(`/view/${req.params.num}`);
    const [ rows, fields ] = await sql.query(`SELECT COUNT(1) FROM problems WHERE num = ${mysql.escape(req.params.num)};`);
    if (rows[0]['COUNT(1)'] <= 0) return res.redirect('/');
    const info = JSON.parse(await fs.readFile(`archive/${req.params.num}/info.json`));
    res.render('description', {
        error: '',
        data: { },
        num: req.params.num,
        providing: info.providing,
        provide: []
    });
});

app.get('/solution/:num/add', async function (req, res) {
    if (!req.session.auth) return res.redirect('/signin');
    if (!req.session.auth.admin) return res.redirect(`/view/${req.params.num}`);
    const [ rows, fields ] = await sql.query(`SELECT COUNT(1) FROM problems WHERE num = ${mysql.escape(req.params.num)};`);
    if (rows[0]['COUNT(1)'] <= 0) return res.redirect('/');
    const info = JSON.parse(await fs.readFile(`archive/${req.params.num}/info.json`));
    res.render('solution', {
        error: '',
        data: { },
        num: req.params.num,
        providing: info.providing
    });
});

app.get('/description/:num/edit/:idx', async function (req, res) {
    if (!req.session.auth) return res.redirect('/signin');
    if (!req.session.auth.admin) return res.redirect(`/view/${req.params.num}`);
    const [ rows, fields ] = await sql.query(`SELECT COUNT(1) FROM problems WHERE num = ${mysql.escape(req.params.num)};`);
    if (rows[0]['COUNT(1)'] <= 0) return res.redirect('/');
    const info = JSON.parse(await fs.readFile(`archive/${req.params.num}/info.json`));
    if (parseInt(req.params.idx) != req.params.idx) return res.redirect(`/description/${req.params.num}`);
    if (info.versions.length <= req.params.idx || req.params.idx < 0) return res.redirect(`/description/${req.params.num}`);
    if (info.versions[req.params.idx].type === 'md') res.render('description', {
        error: '',
        data: {
            edit: 'true',
            pidx: req.params.idx,
            lang: info.versions[req.params.idx].lang,
            desc: info.versions[req.params.idx].name,
            type: 'md',
            md: await fs.readFile(`archive/${req.params.num}/descriptions/${info.versions[req.params.idx].filename}`),
            file: info.versions[req.params.idx].filename
        },
        num: req.params.num,
        providing: info.providing,
        provide: []
    });
    else if (info.versions[req.params.idx].type === 'pdf') res.render('description', {
        error: '',
        data: {
            edit: 'true',
            pidx: req.params.idx,
            lang: info.versions[req.params.idx].lang,
            desc: info.versions[req.params.idx].name,
            type: 'pdf',
            pdf: info.versions[req.params.idx].path
        },
        num: req.params.num,
        providing: info.providing,
        provide: info.versions[req.params.idx].provide
    });
});

app.get('/solution/:num/edit/:idx', async function (req, res) {
    if (!req.session.auth) return res.redirect('/signin');
    if (!req.session.auth.admin) return res.redirect(`/view/${req.params.num}`);
    const [ rows, fields ] = await sql.query(`SELECT COUNT(1) FROM problems WHERE num = ${mysql.escape(req.params.num)};`);
    if (rows[0]['COUNT(1)'] <= 0) return res.redirect('/');
    const info = JSON.parse(await fs.readFile(`archive/${req.params.num}/info.json`));
    if (parseInt(req.params.idx) != req.params.idx) return res.redirect(`/solution/${req.params.num}`);
    if (info.solutions.length <= req.params.idx || req.params.idx < 0) return res.redirect(`/solution/${req.params.num}`);
    if (info.solutions[req.params.idx].type === 'md') res.render('solution', {
        error: '',
        data: {
            edit: 'true',
            pidx: req.params.idx,
            lang: info.solutions[req.params.idx].lang,
            desc: info.solutions[req.params.idx].name,
            type: 'md',
            md: await fs.readFile(`archive/${req.params.num}/solutions/${info.solutions[req.params.idx].filename}`),
            file: info.solutions[req.params.idx].filename
        },
        num: req.params.num,
        providing: info.providing
    });
    else if (info.solutions[req.params.idx].type === 'pdf') res.render('solution', {
        error: '',
        data: {
            edit: 'true',
            pidx: req.params.idx,
            lang: info.solutions[req.params.idx].lang,
            desc: info.solutions[req.params.idx].name,
            type: 'pdf',
            pdf: info.solutions[req.params.idx].path
        },
        num: req.params.num,
        providing: info.providing
    });
});

app.post('/description/:num/delete', async function (req, res) {
    if (!req.session.auth) return res.redirect('/signin');
    if (!req.session.auth.admin) return res.redirect(`/view/${req.params.num}`);
    const [ rows, fields ] = await sql.query(`SELECT COUNT(1) FROM problems WHERE num = ${mysql.escape(req.params.num)};`);
    if (rows[0]['COUNT(1)'] <= 0) return res.redirect('/');
    const idx = req.body.descriptions;
    if (!idx) return res.redirect(`/description/${req.params.num}`);
    const info = JSON.parse(await fs.readFile(`archive/${req.params.num}/info.json`));
    const oldVers = info.versions.slice();
    const desc = info.versions[idx];
    info.versions.splice(idx, 1);
    if (desc.type === 'md') await fs.unlink(`archive/${req.params.num}/descriptions/${desc.filename}`);
    await fs.writeFile(`archive/${req.params.num}/info.json`, JSON.stringify(info));
    await addHistory(req.params.num, req.session.auth.user, 'RMVDSC', desc.name, {
        before: {
            info: {
                versions: oldVers
            }
        },
        after: {
            info: {
                versions: info.versions
            }
        }
    });
    res.redirect(`/description/${req.params.num}`);
});

app.post('/solution/:num/delete', async function (req, res) {
    if (!req.session.auth) return res.redirect('/signin');
    if (!req.session.auth.admin) return res.redirect(`/view/${req.params.num}`);
    const [ rows, fields ] = await sql.query(`SELECT COUNT(1) FROM problems WHERE num = ${mysql.escape(req.params.num)};`);
    if (rows[0]['COUNT(1)'] <= 0) return res.redirect('/');
    const idx = req.body.solutions;
    if (!idx) return res.redirect(`/solution/${req.params.num}`);
    const info = JSON.parse(await fs.readFile(`archive/${req.params.num}/info.json`));
    const oldVers = info.solutions.slice();
    const desc = info.solutions[idx];
    info.solutions.splice(idx, 1);
    if (desc.type === 'md') await fs.unlink(`archive/${req.params.num}/solutions/${desc.filename}`);
    await fs.writeFile(`archive/${req.params.num}/info.json`, JSON.stringify(info));
    await addHistory(req.params.num, req.session.auth.user, 'RMVSOL', desc.name, {
        before: {
            info: {
                solutions: oldVers
            }
        },
        after: {
            info: {
                solutions: info.solutions
            }
        }
    });
    res.redirect(`/solution/${req.params.num}`);
});

app.post('/description/:num/add', async function (req, res) {
    var info = { };
    try {
        info = JSON.parse(await fs.readFile(`archive/${req.params.num}/info.json`));
    } catch (e) { }
    var provide = [ ];
    for (var i = 0; ; i++) {
        if (!req.body[`${i}provide`]) break;
        if (req.body[`${i}provideEnabled`] === 'true') provide.push(req.body[`${i}provide`]);
    }
    if (!req.session.auth) return res.render('description', {
        error: 'Not signed in',
        data: req.body,
        num: req.params.num,
        providing: info.providing,
        provide: provide
    });
    if (!req.session.auth.admin) return res.render('description', {
        error: 'No permission',
        data: req.body,
        num: req.params.num,
        providing: info.providing,
        provide: provide
    });
    const [ rows, fields ] = await sql.query(`SELECT COUNT(1) FROM problems WHERE num = ${mysql.escape(req.params.num)};`);
    if (rows[0]['COUNT(1)'] <= 0) return res.render('description', {
        error: 'Problem moved or deleted',
        data: req.body,
        num: req.params.num,
        providing: info.providing,
        provide: provide
    });
    if (!req.body.desc) return res.render('description', {
        error: 'Name empty',
        data: req.body,
        num: req.params.num,
        providing: info.providing,
        provide: provide
    });
    if (!req.body.lang) return res.render('description', {
        error: 'Lang empty',
        data: req.body,
        num: req.params.num,
        providing: info.providing,
        provide: provide
    });
    if (req.body.edit === 'true') {
        const idx = parseInt(req.body.pidx);
            if (idx != req.body.pidx || idx >= info.versions.length) return res.render('description', {
            error: 'Invalid index',
            data: req.body,
            num: req.params.num,
            providing: info.providing,
            provide: provide
        });
    }
    const oldVers = (info.versions ? info.versions : []).slice();
    if (req.body.type === 'md') {
        if (inappropriate(req.body.file)) return res.render('description', {
            error: 'Filename prohibited',
            data: req.body,
            num: req.params.num,
            providing: info.providing,
            provide: provide
        });
        if (!req.body.file) return res.render('description', {
            error: 'Filename empty',
            data: req.body,
            num: req.params.num,
            providing: info.providing,
            provide: provide
        });
        var l = -1;
        if (info.versions) for (var i = 0; i < info.versions.length; i++) if (info.versions[i].type === 'md' && info.versions[i].filename === req.body.file) l = i;
        if (l != -1 && (req.body.edit !== 'true' || l !== parseInt(req.body.pidx))) return res.render('description', {
            error: 'Filename already exists',
            data: req.body,
            num: req.params.num,
            providing: info.providing,
            provide: provide
        });
        var oldDesc = '';
        var k = -1;
        if (info.versions) for (var i = 0; i < info.versions.length; i++) if (info.versions[i].name === req.body.desc) k = i;
        if (k != -1 && (req.body.edit !== 'true' || k !== parseInt(req.body.pidx))) return res.render('description', {
            error: 'Name already exists',
            data: req.body,
            num: req.params.num,
            providing: info.providing,
            provide: provide
        });
        if (req.body.edit === 'true') {
            if (info.versions[parseInt(req.body.pidx)].type === 'md') {
                oldDesc = (await fs.readFile(`archive/${req.params.num}/descriptions/${info.versions[parseInt(req.body.pidx)].filename}`)).toString();
                await fs.unlink(`archive/${req.params.num}/descriptions/${info.versions[parseInt(req.body.pidx)].filename}`);
            }
            info.versions.splice(parseInt(req.body.pidx), 1);
        }
        await mkdir(`archive/${req.params.num}/descriptions`);
        await fs.writeFile(`archive/${req.params.num}/descriptions/${req.body.file}`, req.body.md.replace(/\r/g, ''));
        if (!info.versions) info.versions = [];
        info.versions.push({
            type: req.body.type,
            lang: req.body.lang,
            filename: req.body.file,
            name: req.body.desc
        });
        await fs.writeFile(`archive/${req.params.num}/info.json`, JSON.stringify(info));
        await addHistory(req.params.num, req.session.auth.user, req.body.edit !== 'true' ? 'CRTDSC' : 'EDTDSC', req.body.desc, {
            before: {
                description: oldDesc,
                info: {
                    versions: oldVers
                }
            },
            after: {
                description: req.body.md,
                info: {
                    versions: info.versions
                }
            }
        });
        res.redirect(`/description/${req.params.num}`);
    } else if (req.body.type === 'pdf') {
        var k = -1;
        if (info.versions) for (var i = 0; i < info.versions.length; i++) if (info.versions[i].name === req.body.desc) k = i;
        if (k != -1 && (req.body.edit !== 'true' || k !== parseInt(req.body.pidx))) return res.render('description', {
            error: 'Name already exists',
            data: req.body,
            num: req.params.num,
            providing: info.providing,
            provide: provide
        });
        if (req.body.edit === 'true') {
            if (info.versions[parseInt(req.body.pidx)].type === 'md') await fs.unlink(`archive/${req.params.num}/descriptions/${info.versions[parseInt(req.body.pidx)].filename}`);
            info.versions.splice(parseInt(req.body.pidx), 1);
        }
        if (!info.versions) info.versions = [];
        info.versions.push({
            type: req.body.type,
            lang: req.body.lang,
            path: req.body.pdf,
            name: req.body.desc,
            provide: provide
        });
        await fs.writeFile(`archive/${req.params.num}/info.json`, JSON.stringify(info));
        await addHistory(req.params.num, req.session.auth.user, req.body.edit !== 'true' ? 'CRTDSC' : 'EDTDSC', req.body.desc, {
            before: {
                info: {
                    versions: oldVers
                }
            },
            after: {
                info: {
                    versions: info.versions
                }
            }
        });
        res.redirect(`/description/${req.params.num}`);
    } else return res.render('description', {
        error: 'Choose description type',
        data: req.body,
        num: req.params.num,
        providing: info.providing,
        provide: provide
    });
});

app.post('/solution/:num/add', async function (req, res) {
    if (!req.session.auth) return res.redirect('/signin');
    if (!req.session.auth.admin) return res.redirect(`/view/${req.params.num}`);
    const [ rows, fields ] = await sql.query(`SELECT COUNT(1) FROM problems WHERE num = ${mysql.escape(req.params.num)};`);
    if (rows[0]['COUNT(1)'] <= 0) return res.redirect('/');
    var info = JSON.parse(await fs.readFile(`archive/${req.params.num}/info.json`));
    if (!req.body.desc) return res.render('solution', {
        error: 'Name empty',
        data: req.body,
        num: req.params.num,
        providing: info.providing
    });
    if (!req.body.lang) return res.render('solution', {
        error: 'Lang empty',
        data: req.body,
        num: req.params.num,
        providing: info.providing
    });
    if (req.body.edit === 'true') {
        const idx = parseInt(req.body.pidx);
            if (idx != req.body.pidx || idx >= info.solutions.length) return res.render('solution', {
            error: 'Invalid index',
            data: req.body,
            num: req.params.num,
            providing: info.providing
        });
    }
    const oldVers = (info.solutions ? info.solutions : []).slice();
    if (req.body.type === 'md') {
        if (inappropriate(req.body.file)) return res.render('solution', {
            error: 'Filename prohibited',
            data: req.body,
            num: req.params.num,
            providing: info.providing
        });
        if (!req.body.file) return res.render('solution', {
            error: 'Filename empty',
            data: req.body,
            num: req.params.num,
            providing: info.providing
        });
        var l = -1;
        if (info.solutions) for (var i = 0; i < info.solutions.length; i++) if (info.solutions[i].type === 'md' && info.solutions[i].filename === req.body.file) l = i;
        if (l != -1 && (req.body.edit !== 'true' || l !== parseInt(req.body.pidx))) return res.render('solution', {
            error: 'Filename already exists',
            data: req.body,
            num: req.params.num,
            providing: info.providing
        });
        var oldDesc = '';
        var k = -1;
        if (info.solutions) for (var i = 0; i < info.solutions.length; i++) if (info.solutions[i].name === req.body.desc) k = i;
        if (k != -1 && (req.body.edit !== 'true' || k !== parseInt(req.body.pidx))) return res.render('solution', {
            error: 'Name already exists',
            data: req.body,
            num: req.params.num,
            providing: info.providing
        });
        if (req.body.edit === 'true') {
            if (info.solutions[parseInt(req.body.pidx)].type === 'md') {
                oldDesc = (await fs.readFile(`archive/${req.params.num}/solutions/${info.solutions[parseInt(req.body.pidx)].filename}`)).toString();
                await fs.unlink(`archive/${req.params.num}/solutions/${info.solutions[parseInt(req.body.pidx)].filename}`);
            }
            info.solutions.splice(parseInt(req.body.pidx), 1);
        }
        await mkdir(`archive/${req.params.num}/solutions`);
        await fs.writeFile(`archive/${req.params.num}/solutions/${req.body.file}`, req.body.md.replace(/\r/g, ''));
        if (!info.solutions) info.solutions = [];
        info.solutions.push({
            type: req.body.type,
            lang: req.body.lang,
            filename: req.body.file,
            name: req.body.desc
        });
        await fs.writeFile(`archive/${req.params.num}/info.json`, JSON.stringify(info));
        await addHistory(req.params.num, req.session.auth.user, req.body.edit !== 'true' ? 'CRTSOL' : 'EDTSOL', req.body.desc, {
            before: {
                solution: oldDesc,
                info: {
                    solutions: oldVers
                }
            },
            after: {
                solution: req.body.md,
                info: {
                    solutions: info.solutions
                }
            }
        });
        res.redirect(`/solution/${req.params.num}`);
    } else if (req.body.type === 'pdf') {
        var k = -1;
        if (info.solutions) for (var i = 0; i < info.solutions.length; i++) if (info.solutions[i].name === req.body.desc) k = i;
        if (k != -1 && (req.body.edit !== 'true' || k !== parseInt(req.body.pidx))) return res.render('solution', {
            error: 'Name already exists',
            data: req.body,
            num: req.params.num,
            providing: info.providing
        });
        if (req.body.edit === 'true') {
            if (info.solutions[parseInt(req.body.pidx)].type === 'md') await fs.unlink(`archive/${req.params.num}/solutions/${info.solutions[parseInt(req.body.pidx)].filename}`);
            info.solutions.splice(parseInt(req.body.pidx), 1);
        }
        if (!info.solutions) info.solutions = [];
        info.solutions.push({
            type: req.body.type,
            lang: req.body.lang,
            path: req.body.pdf,
            name: req.body.desc
        });
        await fs.writeFile(`archive/${req.params.num}/info.json`, JSON.stringify(info));
        await addHistory(req.params.num, req.session.auth.user, req.body.edit !== 'true' ? 'CRTSOL' : 'EDTSOL', req.body.desc, {
            before: {
                info: {
                    solutions: oldVers
                }
            },
            after: {
                info: {
                    solutions: info.solutions
                }
            }
        });
        res.redirect(`/solution/${req.params.num}`);
    } else return res.render('solution', {
        error: 'Choose solution type',
        data: req.body,
        num: req.params.num,
        providing: info.providing
    });
});

app.get('/solutions/:num', async function (req, res) {
    const [ rows, fields ] = await sql.query(`SELECT COUNT(1) FROM problems WHERE num = ${mysql.escape(req.params.num)};`);
    if (rows[0]['COUNT(1)'] <= 0) return res.redirect('/');
    const info = JSON.parse(await fs.readFile(`archive/${req.params.num}/info.json`));
    var contents = [ ];
    for (idx in info.solutions) {
        const obj = info.solutions[idx];
        if (obj.type === 'md') {
            const content = await fs.readFile(`archive/${req.params.num}/solutions/${obj.filename}`);
            contents.push({
                content: content.toString(),
                type: obj.type,
                lang: obj.lang,
                name: obj.name,
            });
        } else if (obj.type === 'pdf') {
            contents.push({
                content: obj.path,
                type: obj.type,
                lang: obj.lang,
                name: obj.name
            });
        }
    }
    return res.render('sol', {
        num: req.params.num,
        info: info,
        contents: contents
    });
});

app.get('/provide/:num', async function (req, res) {
    if (!req.session.auth) return res.redirect('/signin');
    if (!req.session.auth.admin) return res.redirect(`/view/${req.params.num}`);
    const [ rows, fields ] = await sql.query(`SELECT COUNT(1) FROM problems WHERE num = ${mysql.escape(req.params.num)};`);
    if (rows[0]['COUNT(1)'] <= 0) return res.redirect('/');
    await mkdir(`archive/${req.params.num}/providing`);
    const info = JSON.parse(await fs.readFile(`archive/${req.params.num}/info.json`));
    res.render('provide', {
        num: req.params.num,
        providing: info.providing
    });
});

app.get('/helper/:num', async function (req, res) {
    if (!req.session.auth) return res.redirect('/signin');
    if (!req.session.auth.admin) return res.redirect(`/view/${req.params.num}`);
    const [ rows, fields ] = await sql.query(`SELECT COUNT(1) FROM problems WHERE num = ${mysql.escape(req.params.num)};`);
    if (rows[0]['COUNT(1)'] <= 0) return res.redirect('/');
    await mkdir(`archive/${req.params.num}/helper`);
    var helper = [ ];
    try {
        helper = JSON.parse(await fs.readFile(`archive/${req.params.num}/helpers.json`));
    } catch (e) { }
    res.render('helper', {
        num: req.params.num,
        helper: helper
    });
});

app.get('/helper/:num/:idx', async function (req, res) {
    if (!req.session.auth) return res.redirect('/signin');
    if (!req.session.auth.admin) return res.redirect(`/view/${req.params.num}`);
    const [ rows, fields ] = await sql.query(`SELECT COUNT(1) FROM problems WHERE num = ${mysql.escape(req.params.num)};`);
    if (rows[0]['COUNT(1)'] <= 0) return res.redirect('/');
    await mkdir(`archive/${req.params.num}/helper`);
    var helper = [ ];
    try {
        helper = JSON.parse(await fs.readFile(`archive/${req.params.num}/helpers.json`));
    } catch (e) { }
    if (!helper.includes(req.params.idx)) return res.redirect(`/helper/${req.params.num}`);
    res.sendFile(path.join(__dirname, `archive/${req.params.num}/helper/${req.params.idx}`));
});

app.post('/provide/:num', async function (req, res) {
    if (!req.session.auth) return res.redirect('/signin');
    if (!req.session.auth.admin) return res.redirect(`/view/${req.params.num}`);
    if (!req.files || !req.files.upload) return res.redirect(`/provide/${req.params.num}`);
    const name = req.body.name || req.files.upload.name;
    if (inappropriate(name)) return res.redirect(`/provide/${req.params.num}`);
    const [ rows, fields ] = await sql.query(`SELECT COUNT(1) FROM problems WHERE num = ${mysql.escape(req.params.num)};`);
    if (rows[0]['COUNT(1)'] <= 0) return res.redirect('/');
    await mkdir(`archive/${req.params.num}/providing`);
    var info = JSON.parse(await fs.readFile(`archive/${req.params.num}/info.json`));
    if (!info.providing) info.providing = [ ];
    const oldProv = info.providing.slice();
    await upload(req.files.upload, `archive/${req.params.num}/providing/${name}`);
    if (info.providing.includes(name)) {
        await addHistory(req.params.num, req.session.auth.user, 'EDTPRV', name, { });
    } else {
        info.providing.push(name);
        await fs.writeFile(`archive/${req.params.num}/info.json`, JSON.stringify(info));
        await addHistory(req.params.num, req.session.auth.user, 'CRTPRV', name, {
            before: {
                info: {
                    providing: oldProv
                }
            },
            after: {
                info: {
                    providing: info.providing
                }
            }
        });
    }
    res.redirect(`/provide/${req.params.num}`);
});

app.post('/helper/:num', async function (req, res) {
    if (!req.session.auth) return res.redirect('/signin');
    if (!req.session.auth.admin) return res.redirect(`/view/${req.params.num}`);
    if (!req.files || !req.files.upload) return res.redirect(`/helper/${req.params.num}`);
    const name = req.body.name || req.files.upload.name;
    if (inappropriate(name)) return res.redirect(`/helper/${req.params.num}`);
    const [ rows, fields ] = await sql.query(`SELECT COUNT(1) FROM problems WHERE num = ${mysql.escape(req.params.num)};`);
    if (rows[0]['COUNT(1)'] <= 0) return res.redirect('/');
    await mkdir(`archive/${req.params.num}/helper`);
    var helper = [ ];
    try {
        helper = JSON.parse(await fs.readFile(`archive/${req.params.num}/helpers.json`));
    } catch (e) { }
    await upload(req.files.upload, `archive/${req.params.num}/helper/${name}`);
    if (!helper.includes(name)) {
        helper.push(name);
        await fs.writeFile(`archive/${req.params.num}/helpers.json`, JSON.stringify(helper));
    }
    res.redirect(`/helper/${req.params.num}`);
});

app.post('/provide/:num/delete', async function (req, res) {
    if (!req.session.auth) return res.redirect('/signin');
    if (!req.session.auth.admin) return res.redirect(`/view/${req.params.num}`);
    if (!req.body.providings) return res.redirect(`/provide/${req.params.num}`);
    const name = req.body.providings;
    const [ rows, fields ] = await sql.query(`SELECT COUNT(1) FROM problems WHERE num = ${mysql.escape(req.params.num)};`);
    if (rows[0]['COUNT(1)'] <= 0) return res.redirect('/');
    var info = JSON.parse(await fs.readFile(`archive/${req.params.num}/info.json`));
    const oldProv = info.providing.slice();
    const k = info.providing.indexOf(name);
    if (k === -1) return res.redirect(`/provide/${req.params.num}`);
    info.providing.splice(k, 1);
    await fs.unlink(`archive/${req.params.num}/providing/${name}`);
    await fs.writeFile(`archive/${req.params.num}/info.json`, JSON.stringify(info));
    await addHistory(req.params.num, req.session.auth.user, 'RMVPRV', name, {
        before: {
            info: {
                providing: oldProv
            }
        },
        after: {
            info: {
                providing: info.providing
            }
        }
    });
    res.redirect(`/provide/${req.params.num}`);
});

app.post('/helper/:num/delete', async function (req, res) {
    if (!req.session.auth) return res.redirect('/signin');
    if (!req.session.auth.admin) return res.redirect(`/view/${req.params.num}`);
    if (!req.body.helper) return res.redirect(`/helper/${req.params.num}`);
    const name = req.body.helper;
    const [ rows, fields ] = await sql.query(`SELECT COUNT(1) FROM problems WHERE num = ${mysql.escape(req.params.num)};`);
    if (rows[0]['COUNT(1)'] <= 0) return res.redirect('/');
    var helper = [ ];
    try {
        helper = JSON.parse(await fs.readFile(`archive/${req.params.num}/helpers.json`));
    } catch (e) { }
    const k = helper.indexOf(name);
    if (k === -1) return res.redirect(`/helper/${req.params.num}`);
    helper.splice(k, 1);
    await fs.unlink(`archive/${req.params.num}/helper/${name}`);
    await fs.writeFile(`archive/${req.params.num}/helpers.json`, JSON.stringify(helper));
    res.redirect(`/helper/${req.params.num}`);
});

app.get('/rename/:num', async function (req, res) {
    if (!req.session.auth) return res.redirect('/signin');
    if (!req.session.auth.admin) return res.redirect(`/view/${req.params.num}`);
    const [ rows, fields ] = await sql.query(`SELECT COUNT(1) FROM problems WHERE num = ${mysql.escape(req.params.num)};`);
    if (rows[0]['COUNT(1)'] <= 0) return res.redirect('/');
    var info = JSON.parse(await fs.readFile(`archive/${req.params.num}/info.json`));
    res.render('rename', {
        num: req.params.num,
        title: info.title
    });
});

app.post('/rename/:num', async function (req, res) {
    if (!req.session.auth) return res.redirect('/signin');
    if (!req.session.auth.admin) return res.redirect(`/view/${req.params.num}`);
    const [ rows, fields ] = await sql.query(`SELECT COUNT(1) FROM problems WHERE num = ${mysql.escape(req.params.num)};`);
    if (rows[0]['COUNT(1)'] <= 0) return res.redirect('/');
    if (req.body.title.length <= 0) return res.redirect(`/rename/${req.params.num}`);
    sql.query(`UPDATE problems SET title = ${mysql.escape(req.body.title)} WHERE num = ${mysql.escape(req.params.num)}`);
    var info = JSON.parse(await fs.readFile(`archive/${req.params.num}/info.json`));
    const oldTitle = info.title;
    info.title = req.body.title;
    await fs.writeFile(`archive/${req.params.num}/info.json`, JSON.stringify(info));
    await addHistory(req.params.num, req.session.auth.user, 'EDTTTL', info.title, {
        before: {
            info: {
                title: oldTitle
            }
        },
        after: {
            info: {
                title: info.title
            }
        }
    });
    info = JSON.parse(await fs.readFile(`archive/problems.json`));
    info.problems[req.params.num].title = req.body.title;
    await fs.writeFile(`archive/problems.json`, JSON.stringify(info));
    res.redirect(`/view/${req.params.num}`);
});

app.get('/examples/:num', async function (req, res) {
    if (!req.session.auth) return res.redirect('/signin');
    if (!req.session.auth.admin) return res.redirect(`/view/${req.params.num}`);
    const [ rows, fields ] = await sql.query(`SELECT COUNT(1) FROM problems WHERE num = ${mysql.escape(req.params.num)};`);
    if (rows[0]['COUNT(1)'] <= 0) return res.redirect('/');
    const info = JSON.parse(await fs.readFile(`archive/${req.params.num}/info.json`));
    var examples = [ ];
    try {
        examples = JSON.parse(await fs.readFile(`archive/${req.params.num}/examples.json`));
    } catch (e) { }
    res.render('examples', {
        num: req.params.num,
        info: info,
        examples: examples
    });
});

app.post('/examples/:num', async function (req, res) {
    if (!req.session.auth) return res.redirect('/signin');
    if (!req.session.auth.admin) return res.redirect(`/view/${req.params.num}`);
    const [ rows, fields ] = await sql.query(`SELECT COUNT(1) FROM problems WHERE num = ${mysql.escape(req.params.num)};`);
    if (rows[0]['COUNT(1)'] <= 0) return res.redirect('/');
    var oldEx = [ ];
    try {
        oldEx = JSON.parse(await fs.readFile(`archive/${req.params.num}/examples.json`));
    } catch (e) { }
    var examples = [ ];
    for (var i = 0; ; i++) {
        if (req.body[`${i}input`] === undefined || req.body[`${i}output`] === undefined || req.body[`${i}desc`] === undefined) break;
        examples.push({
            input: req.body[`${i}input`],
            output: req.body[`${i}output`],
            desc: req.body[`${i}desc`],
            enabled: req.body[`${i}enabled`] ? true : false,
            use: req.body[`${i}use`] ? true : false
        });
    }
    await fs.writeFile(`archive/${req.params.num}/examples.json`, JSON.stringify(examples));
    await addHistory(req.params.num, req.session.auth.user, 'EDTEXP', null, {
        before: {
            examples: oldEx
        },
        after: {
            examples: examples
        }
    });
    res.redirect(`/view/${req.params.num}`);
})

app.get('/row/:num', async function (req, res) {
    if (parseInt(req.params.num) != req.params.num) return res.send('Not Found');
    const [ rows, fields ] = await sql.query(`SELECT problem, user, type, arg, date FROM histories WHERE cnt = ${parseInt(req.params.num)};`);
    if (rows.length <= 0) res.send('Not Found');
    var changelog = {
        before: { },
        after: { }
    };
    try {
        changelog = JSON.parse(await fs.readFile(`changelog/${req.params.num}`));
    } catch (e) { }
    var cl = [ ];
    var keys = [ ];
    if (changelog.before) for (key in changelog.before) if (key !== 'info' && !keys.includes(key)) keys.push(key);
    if (changelog.after) for (key in changelog.after) if (key !== 'info' && !keys.includes(key)) keys.push(key);
    keys.forEach(function (item) {
        cl.push({
            key: item,
            before: JSON.stringify(changelog.before[item]),
            after: JSON.stringify(changelog.after[item])
        });
    });
    keys = [ ];
    if (changelog.before && changelog.before.info) for (key in changelog.before.info) if (!keys.includes(key)) keys.push(key);
    if (changelog.after && changelog.after.info) for (key in changelog.after.info) if (!keys.includes(key)) keys.push(key);
    keys.forEach(function (item) {
        cl.push({
            key: item,
            before: JSON.stringify(changelog.before.info ? changelog.before.info[item] : ''),
            after: JSON.stringify(changelog.after.info ? changelog.after.info[item] : '')
        });
    });
    res.render('row', {
        num: req.params.num,
        prenum: rows[0].problem,
        info: rows[0],
        changelog: cl,
        getHistory: getHistory
    })
});

app.get('/data/:num', async function (req, res) {
    if (!req.session.auth) return res.redirect('/signin');
    if (!req.session.auth.admin) return res.redirect(`/view/${req.params.num}`);
    const [ rows, fields ] = await sql.query(`SELECT COUNT(1) FROM problems WHERE num = ${mysql.escape(req.params.num)};`);
    if (rows[0]['COUNT(1)'] <= 0) return res.redirect('/');
    var data = [];
    try {
        data = JSON.parse(await fs.readFile(`archive/${req.params.num}/data.json`));
    } catch (e) { }
    res.render('data', {
        num: req.params.num,
        data: data
    });
});

app.get('/data/:num/add', async function (req, res) {
    if (!req.session.auth) return res.redirect('/signin');
    if (!req.session.auth.admin) return res.redirect(`/view/${req.params.num}`);
    const [ rows, fields ] = await sql.query(`SELECT COUNT(1) FROM problems WHERE num = ${mysql.escape(req.params.num)};`);
    if (rows[0]['COUNT(1)'] <= 0) return res.redirect('/');
    var data = [ ];
    try {
        data = JSON.parse(await fs.readFile(`archive/${req.params.num}/data.json`));
    } catch (e) { }
    var datalt = [ ];
    for (var i = 0; i < data.length; i++) datalt.push(data[i].desc);
    res.render('dataset', {
        data: { },
        num: req.params.num,
        datalt: datalt,
        dataset: [ ]
    });
});

app.get('/data/:num/edit/:idx', async function (req, res) {
    if (!req.session.auth) return res.redirect('/signin');
    if (!req.session.auth.admin) return res.redirect(`/view/${req.params.num}`);
    const [ rows, fields ] = await sql.query(`SELECT COUNT(1) FROM problems WHERE num = ${mysql.escape(req.params.num)};`);
    if (rows[0]['COUNT(1)'] <= 0) return res.redirect('/');
    var data = [];
    try {
        data = JSON.parse(await fs.readFile(`archive/${req.params.num}/data.json`));
    } catch (e) { }
    var datalt = [ ];
    for (var i = 0; i < data.length; i++) datalt.push(data[i].desc);
    if (parseInt(req.params.idx) != req.params.idx) return res.redirect(`/data/${req.params.num}`);
    if (data.length <= req.params.idx || req.params.idx < 0) return res.redirect(`/data/${req.params.num}`);
    res.render('dataset', {
        data: {
            edit: 'true',
            pidx: req.params.idx,
            desc: data[req.params.idx].name
        },
        num: req.params.num,
        datalt: datalt,
        dataset: data[req.params.idx].data
    });
});

app.post('/data/:num/delete', async function (req, res) {
    if (!req.session.auth) return res.redirect('/signin');
    if (!req.session.auth.admin) return res.redirect(`/view/${req.params.num}`);
    const [ rows, fields ] = await sql.query(`SELECT COUNT(1) FROM problems WHERE num = ${mysql.escape(req.params.num)};`);
    if (rows[0]['COUNT(1)'] <= 0) return res.redirect('/');
    const idx = req.body.data;
    if (!idx) return res.redirect(`/data/${req.params.num}`);
    var data = [];
    try {
        data = JSON.parse(await fs.readFile(`archive/${req.params.num}/data.json`));
    } catch (e) { }
    await fs.unlink(`archive/${req.params.num}/data/${data[idx].name}.zip`);
    data.splice(idx, 1);
    await fs.writeFile(`archive/${req.params.num}/data.json`, JSON.stringify(data));
    res.redirect(`/data/${req.params.num}`);
});

async function searchIn(dir) {
    var lt = [ ];
    const content = await fs.readdir(dir);
    for (file in content) {
        const fullPath = path.join(dir, content[file]);
        if ((await fs.lstat(fullPath)).isDirectory()) {
            const res = await searchIn(fullPath);
            for (item in res) lt.push(res[item]);
        } else lt.push(fullPath);
    }
    return lt;
}

function includeName(lt, x) {
    for (var i = 0; i < lt.length; i++) if (lt[i].name === x) return true;
    return false;
}

function includeFile(lt, x) {
    for (var i = 0; i < lt.length; i++) if (lt[i].file === x) return true;
    return false;
}

function searchPath(lt, x) {
    for (var i = 0; i < lt.length; i++) if (lt[i].name === x) return lt[i].path;
    return '';
}

function omitExtension(x) {
    var y = x.split('.');
    y.pop();
    return y.join('.');
}

app.post('/data/:num/add', async function (req, res) {
    if (!req.session.auth) return res.json({
        type: 'redirect',
        url: '/signin'
    });
    if (!req.session.auth.admin) return res.json({
        type: 'redirect',
        url: `/view/${req.params.num}`
    });
    const [ rows, fields ] = await sql.query(`SELECT COUNT(1) FROM problems WHERE num = ${mysql.escape(req.params.num)};`);
    if (rows[0]['COUNT(1)'] <= 0) return res.json({
        type: 'redirect',
        url: '/'
    });
    if (!req.body.desc) return res.json({
        type: 'redirect',
        url: `/data/${req.params.num}`
    });
    var data = [];
    try {
        data = JSON.parse(await fs.readFile(`archive/${req.params.num}/data.json`));
    } catch (e) { }
    var k = -1;
    var oldData = {};
    for (var i = 0; i < data.length; i++) if (data[i].name === req.body.desc) k = i;
    if (k != -1 && (req.body.edit !== 'true' || k !== parseInt(req.body.pidx))) return res.json({
        type: 'redirect',
        url: `/data/${req.params.num}`
    });
    if (req.body.edit === 'true') {
        if (parseInt(req.body.pidx) != req.body.pidx) return res.json({
            type: 'redirect',
            url: `/data/${req.params.num}`
        });
        if (data.length <= req.body.pidx || req.body.pidx < 0) return res.json({
            type: 'redirect',
            url: `/data/${req.params.num}`
        });
        oldData = data[req.body.pidx];
        data.splice(req.body.pidx, 1);
    }
    try {
        await fs.rmdir(`archive/${req.params.num}/data/tmp`, {
            recursive: true,
            force: true
        });
    } catch (e) { }
    await mkdir(`archive/${req.params.num}/data/tmp`);
    var fileList = [ ];
    if (req.body.edit === 'true') {
        await decompress(`archive/${req.params.num}/data/${req.body.desc}.zip`, `archive/${req.params.num}/data/tmp/${req.body.desc}`);
        for (var i = 0; i < oldData.data.length; i++) if (!req.body[`${i}delete`]) {
            fileList.push({
                path: `archive/${req.params.num}/data/tmp/${req.body.desc}/${oldData.data[i]}.in`,
                name: `${oldData.data[i]}.in`
            });
            fileList.push({
                path: `archive/${req.params.num}/data/tmp/${req.body.desc}/${oldData.data[i]}.out`,
                name: `${oldData.data[i]}.out`
            });
        }
    }
    for (idx in req.files) {
        await upload(req.files[idx], `archive/${req.params.num}/data/tmp/${req.files[idx].name}`)
        if ([...req.files[idx].name.matchAll('\\.zip$')].length > 0) {
            await decompress(`archive/${req.params.num}/data/tmp/${req.files[idx].name}`, `archive/${req.params.num}/data/tmp/${omitExtension(path.basename(req.files[idx].name))}`);
            (await searchIn(`archive/${req.params.num}/data/tmp/${omitExtension(path.basename(req.files[idx].name))}`)).forEach(function (item) {
                if ([...item.matchAll('\\.(in|out)$')].length > 0 && !includeName(fileList, path.basename(item))) fileList.push({
                    path: item,
                    name: path.basename(item)
                });
            });
        } else if ([...req.files[idx].name.matchAll('\\.(in|out)$')].length > 0 && !includeName(fileList, req.files[idx].name)) fileList.push({
            path: `archive/${req.params.num}/data/tmp/${req.files[idx].name}`,
            name: req.files[idx].name
        });
    }
    var nameList = [ ];
    for (idx in fileList) {
        var filename = omitExtension(fileList[idx].name);
        if (!nameList.includes(filename)) nameList.push(filename);
    }
    nameList.sort();
    const zip = archiver('zip', { zlib: { level: 9 }});
    zip.on('warning', function (warn) {
        console.log('Archiver warning: ', warn);
    });
    zip.on('error', function (err) {
        console.log('Archiver error: ', err);
    });
    const writeStream = fsStream.createWriteStream(path.join(__dirname, `archive/${req.params.num}/data/${req.body.desc}.zip`));
    zip.pipe(writeStream);
    for (idx in nameList) {
        const basename = nameList[idx];
        const input = searchPath(fileList, basename + '.in');
        const output = searchPath(fileList, basename + '.out');
        zip.append(fsStream.createReadStream(input), {
            name: basename + '.in'
        });
        zip.append(fsStream.createReadStream(output), {
            name: basename + '.out'
        });
    }
    await zip.finalize();
    data.push({
        name: req.body.desc,
        data: nameList
    });
    await fs.writeFile(`archive/${req.params.num}/data.json`, JSON.stringify(data));
    await fs.rmdir(`archive/${req.params.num}/data/tmp`, {
        recursive: true,
        force: true
    });
    var grading = { };
    try {
        grading = JSON.parse(await fs.readFile(`archive/${req.params.num}/grading.json`));
    } catch (e) { }
    grading.gradable = false;
    await fs.writeFile(`archive/${req.params.num}/grading.json`, JSON.stringify(grading));
    return res.json({
        type: 'redirect',
        url: `/data/${req.params.num}`
    });
});

app.get('/languages', async function (req, res) {
    if (!req.session.auth) return res.redirect('/signin');
    if (!req.session.auth.admin) return res.redirect('/');
    var languages = [ ];
    try {
        languages = JSON.parse(await fs.readFile('grading/languages.json'));
    } catch (e) { }
    res.render('languages', {
        languages: languages
    });
});

app.get('/languages/add', async function (req, res) {
    if (!req.session.auth) return res.redirect('/signin');
    if (!req.session.auth.admin) return res.redirect('/');
    res.render('languagesAdd', {
        error: '',
        data: { }
    });
});

app.post('/languages/delete', async function (req, res) {
    if (!req.session.auth) return res.redirect('/signin');
    if (!req.session.auth.admin) return res.redirect('/');
    var languages = [ ];
    try {
        languages = JSON.parse(await fs.readFile('grading/languages.json'));
    } catch (e) { }
    const selectedId = req.body.languages;
    var k = -1;
    for (var i = 0; i < languages.length; i++) if (selectedId === languages[i].id) k = i;
    if (k == -1) return res.redirect('/languages');
    await fs.unlink(`grading/compilers/${selectedId}.sh`);
    await fs.unlink(`grading/compilers/${selectedId}-run.sh`);
    languages.splice(k, 1);
    await fs.writeFile('grading/languages.json', JSON.stringify(languages));
    res.redirect('/languages');
});

app.get('/languages/edit/:idx', async function (req, res) {
    if (!req.session.auth) return res.redirect('/signin');
    if (!req.session.auth.admin) return res.redirect('/');
    var languages = [ ];
    try {
        languages = JSON.parse(await fs.readFile('grading/languages.json'));
    } catch (e) { }
    var k = -1;
    for (var i = 0; i < languages.length; i++) if (req.params.idx === languages[i].id) k = i;
    if (k == -1) return res.redirect('/languages');
    var data = {
        edit: 'true',
        name: languages[k].name,
        id: languages[k].id,
        args: languages[k].args,
        compile: (await fs.readFile(`grading/compilers/${req.params.idx}.sh`)).toString(),
        execute: (await fs.readFile(`grading/compilers/${req.params.idx}-run.sh`)).toString()
    };
    for (idx in languages[k].submittings) {
        const curr = languages[k].submittings[idx];
        data[`${idx}submitting`] = curr;
        data[`${idx}submittingEnabled`] = true;
    }
    res.render('languagesAdd', {
        error: '',
        data: data
    });
});

app.post('/languages/add', async function (req, res) {
    if (!req.session.auth) return res.redirect('/signin');
    if (!req.session.auth.admin) return res.redirect('/');
    var languages = [ ];
    try {
        languages = JSON.parse(await fs.readFile('grading/languages.json'));
    } catch (e) { }
    if (!req.body.name) return res.render('languagesAdd', {
        error: 'Name empty',
        data: req.body
    });
    if (!req.body.id) return res.render('languagesAdd', {
        error: 'Id empty',
        data: req.body
    });
    if (inappropriate(req.body.id)) return res.render('languagesAdd', {
        error: 'Id prohibited',
        data: req.body
    });
    var k = -1;
    for (var i = 0; i < languages.length; i++) if (languages[i].id === req.body.id) k = i;
    if (k != -1 && req.body.edit !== 'true') return res.render('languagesAdd', {
        error: 'Id already exists',
        data: req.body
    });
    if (req.body.edit === 'true') {
        languages.splice(k, 1);
    }
    var submittings = [ ];
    for (var i = 0; ; i++) {
        if (!req.body[`${i}submitting`]) break;
        if (req.body[`${i}submittingEnabled`] === 'true') submittings.push(req.body[`${i}submitting`]);
    }
    languages.push( {
        name: req.body.name,
        id: req.body.id,
        submittings: submittings,
        args: req.body.args
    });
    await fs.writeFile(`grading/compilers/${req.body.id}.sh`, req.body.compile.replace(/\r/g, ''));
    await fs.writeFile(`grading/compilers/${req.body.id}-run.sh`, req.body.execute.replace(/\r/g, ''));
    await exec(`chmod +x "grading/compilers/${req.body.id}.sh"`);
    await exec(`chmod +x "grading/compilers/${req.body.id}-run.sh"`);
    await fs.writeFile('grading/languages.json', JSON.stringify(languages));
    res.redirect('/languages');
});

app.get('/grading/:num', async function (req, res) {
    if (!req.session.auth) return res.redirect('/signin');
    if (!req.session.auth.admin) return res.redirect(`/view/${req.params.num}`);
    const [ rows, fields ] = await sql.query(`SELECT COUNT(1) FROM problems WHERE num = ${mysql.escape(req.params.num)};`);
    if (rows[0]['COUNT(1)'] <= 0) return res.redirect('/');
    var grading = { };
    try {
        grading = JSON.parse(await fs.readFile(`archive/${req.params.num}/grading.json`));
    } catch (e) { }
    var data = [];
    try {
        data = JSON.parse(await fs.readFile(`archive/${req.params.num}/data.json`));
    } catch (e) { }
    var helper = [ ];
    try {
        helper = JSON.parse(await fs.readFile(`archive/${req.params.num}/helpers.json`));
    } catch (e) { }
    const info = JSON.parse(await fs.readFile(`archive/${req.params.num}/info.json`));
    const checkers = (await sql.query(`SELECT file, description FROM checkers;`))[0];
    var languages = [ ];
    try {
        languages = JSON.parse(await fs.readFile('grading/languages.json'));
    } catch (e) { }
    res.render('grading', {
        id: genID(),
        num: req.params.num,
        grading: grading,
        dataset: data,
        helper: helper,
        info: info,
        checkers: checkers,
        languages: languages
    });
});

app.post('/grading/:num', async function (req, res) {
    if (!req.session.auth) return res.redirect('/signin');
    if (!req.session.auth.admin) return res.redirect(`/view/${req.params.num}`);
    const [ rows, fields ] = await sql.query(`SELECT COUNT(1) FROM problems WHERE num = ${mysql.escape(req.params.num)};`);
    if (rows[0]['COUNT(1)'] <= 0) return res.redirect('/');
    var data = [];
    try {
        data = JSON.parse(await fs.readFile(`archive/${req.params.num}/data.json`));
    } catch (e) { }
    var helper = [ ];
    try {
        helper = JSON.parse(await fs.readFile(`archive/${req.params.num}/helpers.json`));
    } catch (e) { }
    const info = JSON.parse(await fs.readFile(`archive/${req.params.num}/info.json`));
    const checkers = (await sql.query(`SELECT file, description FROM checkers;`))[0];
    var languages = [ ];
    try {
        languages = JSON.parse(await fs.readFile('grading/languages.json'));
    } catch (e) { }
    if (parseInt(req.body.subtaskCnt) != req.body.subtaskCnt || parseInt(req.body.subtaskCnt) < 0 || parseInt(req.body.languagesCnt) != req.body.languagesCnt || parseInt(req.body.languagesCnt) < 0) return res.json({
        type: 'error',
        error: 'Invalid'
    });
    if (parseInt(req.body.subtaskCnt) <= 0 || parseInt(req.body.languagesCnt) <= 0) req.body.gradable = false;
    const subtaskLen = parseInt(req.body.subtaskCnt);
    var gradingFiles = {
        checkers: [ ],
        validators: [ ]
    };
    for (var i = 0; i < subtaskLen; i++) {
        if (parseInt(req.body[`${i}tl`]) != req.body[`${i}tl`] || parseInt(req.body[`${i}tl`]) < 0) return res.json({
            type: 'error',
            error: 'Invalid time limit'
        });
        if (parseInt(req.body[`${i}wl`]) != req.body[`${i}wl`] || parseInt(req.body[`${i}wl`]) < 0) return res.json({
            type: 'error',
            error: 'Invalid wall clock limit'
        });
        if (parseInt(req.body[`${i}ml`]) != req.body[`${i}ml`] || parseInt(req.body[`${i}ml`]) < 0) return res.json({
            type: 'error',
            error: 'Invalid memory limit'
        });
        var hierarchies = [ ];
        for (var j = 0; ; j++) {
            if (req.body[`${i}-${j}hierarchy`] === undefined) break;
            if (req.body[`${i}-${j}hierarchyEnabled`] === 'true') hierarchies.push(req.body[`${i}-${j}hierarchy`]);
        }
        for (var idx = 0; idx < hierarchies.length; idx++) {
            const curr = hierarchies[idx];
            if (parseInt(curr) != curr || parseInt(curr) <= 0 || parseInt(curr) >= i + 1) return res.json({
                type: 'error',
                error: 'Invalid hierarchies'
            });
            hierarchies[idx] = parseInt(curr);
            for (var jdx = 0; jdx < idx; jdx++) if (hierarchies[idx] == hierarchies[jdx]) return res.json({
                type: 'error',
                error: 'Invalid hierarchies'
            });
        }
        var k = -1;
        for (var j = 0; j < data.length; j++) if (data[j].name === req.body[`${i}dataset`]) k = j;
        if (k == -1) return res.json({
            type: 'error',
            error: 'Invalid dataset'
        });
        var validRegex = true, regex = null;
        try {
            regex = new RegExp (req.body[`${i}regex`]);
        } catch (e) {
            return res.json({
                type: 'error',
                error: 'Invalid regex'
            });
        }
        var cntData = 0;
        for (var idx = 0; idx < data[k].data.length; idx++) {
            const curr = data[k].data[idx];
            if (regex.test(curr)) cntData++;
        }
        if (cntData <= 0) return res.json({
            type: 'error',
            error: 'No data'
        });
        if (parseInt(req.body[`${i}marks`]) != req.body[`${i}marks`] || req.body[`${i}marks`] < 0) return res.json({
            type: 'error',
            error: 'Invalid marks'
        });
        if (req.body[`${i}validator`] !== 'none' && ([...req.body[`${i}validator`].matchAll('^helper/')].length <= 0 || !helper.includes(req.body[`${i}validator`].substr(7)))) return res.json({
            type: 'error',
            error: 'Invalid validator'
        });
        if (([...req.body[`${i}checker`].matchAll('^checkers/')].length <= 0 || !includeFile(checkers, req.body[`${i}checker`].substr(9))) && ([...req.body[`${i}checker`].matchAll('^helper/')].length <= 0 || !helper.includes(req.body[`${i}checker`].substr(7)))) return res.json({
            type: 'error',
            error: 'Invalid checker'
        });
        if ([...req.body[`${i}checker`].matchAll('^checkers/')].length > 0) gradingFiles.checkers.push(`grading/checkers/${req.body[`${i}checker`].substr(9)}.cpp`);
        else if ([...req.body[`${i}checker`].matchAll('^helper/')].length > 0) gradingFiles.checkers.push(`archive/${req.params.num}/helper/${req.body[`${i}checker`].substr(7)}`);
        if (req.body[`${i}validator`] !== 'none') {
            var currValidate = {
                validator: `archive/${req.params.num}/helper/${req.body[`${i}validator`].substr(7)}`,
                dataset: req.body[`${i}dataset`],
                data: [ ],
                hierarchies: hierarchies,
                subtask: i + 1,
            }
            for (var idx = 0; idx < data[k].data.length; idx++) {
                const curr = data[k].data[idx];
                if (regex.test(curr)) currValidate.data.push(curr);
            }
            gradingFiles.validators.push(currValidate);
        }
    }
    const languagesLen = parseInt(req.body.languagesLen);
    for (var i = 0; i < languagesLen; i++) {
        if (!languages.includes(req.body[`${i}lang`])) return res.json({
            type: 'error',
            error: 'Invalid language'
        });
        var necessaries = [ ];
        for (var j = 0; ; j++) {
            if (req.body[`${i}-${j}helper`] === undefined) break;
            if (req.body[`${i}-${j}helperEnabled`] === 'true') necessaries.push(req.body[`${i}-${j}helper`]);
        }
        for (var j = 0; j < necessaries.length; j++) {
            if (!helper.includes(necessaries[j])) return res.json({
                type: 'error',
                error: 'Invalid helper'
            });
            for (var k = 0; k < j; k++) if (necessaries[j] == necessaries[k]) return res.json({
                type: 'error',
                error: 'Invalid helper'
            });
        }
    }
    queue.push({
        type: 'grading',
        body: req.body,
        files: gradingFiles,
        time: Date.now(),
        user: req.session.auth.user,
        problem: req.params.num,
        id: req.body.id
    });
    tryGrading();
    return res.json({
        type: 'done',
        message: 'Compiling & Validating...'
    });
});

app.get('/move/:num', async function (req, res) {
    if (!req.session.auth) return res.redirect('/signin');
    if (!req.session.auth.admin) return res.redirect(`/view/${req.params.num}`);
    const [ rows, fields ] = await sql.query(`SELECT COUNT(1) FROM problems WHERE num = ${mysql.escape(req.params.num)};`);
    if (rows[0]['COUNT(1)'] <= 0) return res.redirect('/');
});

app.get('/:num', function (req, res) {
    return res.redirect(`/view/${req.params.num}`);
});

app.get('*', function (req, res) {
    return res.send('Not Found');
});

function getResult(x) {
    if (!x) return 'Not Marked';
    if (x == 'WA') return 'Wrong Answer';
    if (x == 'AC') return 'Accepted';
    if (x == 'TL') return 'Time Limit Exceeded';
    if (x == 'WL') return 'Wall Clock Limit Exceeded';
    if (x == 'ML') return 'Memory Limit Exceeded';
    if (x == 'RE') return 'Runtime Error';
    if (x == 'SD') return 'Submission Died';
    if (x == 'CE') return 'Compilation Failed';
    if (x == 'CR') return 'Compiler Died';
    if (x == 'CL') return 'Compilation Takes Too Long';
    if (x == 'CD') return 'Checker Died';
    if (x == 'FL') return 'Failed';
    if (x == 'SK') return 'Skipped';
    if (x == 'PC') return 'Partially Correct';
    if (x == 'OE') return 'Output Limit Exceeded';
    if (x == 'DL') return 'Deleted';
    if (x == 'RD') return 'Preparing Data';
    if (x == 'FD') return 'Downloading Data';
    if (x == 'CP') return 'Compiling';
    if (x == 'GD') return 'Marking';
    if (x == 'PE') return 'Presentation Error';
    if (x == 'XE') return 'Extra Information';
    return 'Unknown';
}

const port = 3000;
http.listen(port, function (req, res) {
    console.log('HTTP is listening on port ' + port);
});

const workerNum = 3;

(function initialize() {
    for (var i = 0; i < workerNum; i++) {
        var curr = new Worker (path.join(__dirname, 'worker.js'), {
            workerData: {
                workerNum: i
            }
        });
        workers.push({
            machine: curr,
            busy: false
        });

        curr.on('message', async function (msg) {
            console.log('From worker: ' + JSON.stringify(msg));
            if (msg.data == 'free') {
                workers[msg.workerNum].busy = false;
                tryGrading();
            }
            if (msg.data == 'busy') workers[msg.workerNum].busy = true;
            if (msg.data == 'updt') {
                if (msg.content.type === 'execute') {
                    var done = 1;
                    if (msg.content.result.done !== undefined) {
                        done = msg.content.result.done;
                        if (msg.content.result.total !== undefined) done = msg.content.result.done / msg.content.result.total;
                    }
                    if (msg.content.result.result == 'AC') {
                        const [ rows, fields ] = await sql.query(`SELECT result FROM submissions WHERE id = ${mysql.escape(msg.content.id)};`);
                        if (rows.length > 0 && rows[0].result !== 'AC') await sql.query(`UPDATE problems SET correctCnt = correctCnt + 1 WHERE num = ${mysql.escape(msg.content.problem)};`);
                    }
                    queries.push(`UPDATE submissions SET result = ${mysql.escape(msg.content.result.result)}, marks = ${mysql.escape(msg.content.result.score)} WHERE id = ${mysql.escape(msg.content.id)};`);
                    if (msg.content.result.time !== undefined) await sql.query(`UPDATE submissions SET time = ${msg.content.result.time} WHERE id = ${mysql.escape(msg.content.id)};`);
                    if (msg.content.result.walltime !== undefined) await sql.query(`UPDATE submissions SET walltime = ${msg.content.result.walltime} WHERE id = ${mysql.escape(msg.content.id)};`);
                    if (msg.content.result.mem !== undefined) await sql.query(`UPDATE submissions SET memory = ${msg.content.result.mem} WHERE id = ${mysql.escape(msg.content.id)};`);
                    if (msg.content.result.subResult !== undefined) for (var i = 0; i < msg.content.result.subResult.length; i++) {
                        queries.push(`INSERT INTO subtasks (id, subtask, result, marks, time, walltime, mem) VALUES (${mysql.escape(msg.content.id)}, ${mysql.escape(i + 1)}, ${mysql.escape(msg.content.result.subResult[i])}, ${mysql.escape(msg.content.result.subPoints[i])}, ${mysql.escape(msg.content.result.subTime[i])}, ${mysql.escape(msg.content.result.subWalltime[i])}, ${mysql.escape(msg.content.result.subMem[i])}) ON DUPLICATE KEY UPDATE result = ${mysql.escape(msg.content.result.subResult[i])}, marks = ${mysql.escape(msg.content.result.subPoints[i])}, time = ${mysql.escape(msg.content.result.subTime[i])}, walltime = ${mysql.escape(msg.content.result.subWalltime[i])}, mem = ${mysql.escape(msg.content.result.subMem[i])}`)
                    }
                    var subProgress = [ ];
                    if (msg.content.result.subDone !== undefined) for (var i = 0; i < msg.content.result.subDone.length; i++) subProgress.push(msg.content.result.subDone[i] / msg.content.result.subTotal[i]);
                    var subResult = [ ];
                    if (msg.content.result.subResult !== undefined) for (var i = 0; i < msg.content.result.subResult.length; i++) subResult.push(getResult(msg.content.result.subResult[i]));
                    var subPoints = [ ];
                    if (msg.content.result.subPoints !== undefined) for (var i = 0; i < msg.content.result.subPoints.length; i++) subPoints.push(msg.content.result.subPoints[i] * msg.content.result.max[i]);
                    if (idSockets[msg.content.id]) idSockets[msg.content.id].forEach(function (item, index, object) {
                        if (Date.now() - socketList[item].time > 24 * 60 * 60 * 1000) object.splice(index, 1);
                        io.to(item).emit('updt', {
                            result: getResult(msg.content.result.result),
                            time: msg.content.result.time,
                            mem: msg.content.result.mem,
                            score: msg.content.result.score,
                            progress: done,
                            subProgress: subProgress,
                            subResult: subResult,
                            subPoints: subPoints,
                            subTime: msg.content.result.subTime,
                            subWalltime: msg.content.result.subWalltime,
                            subMem: msg.content.result.subMem,
                            log: msg.content.result.log
                        });
                    });
                } else if (msg.content.type === 'checker') {
                    if (msg.content.edit !== 'true') {
                        if (msg.content.result.result === 'AC') {
                            const [ rows, fields ] = await sql.query(`SELECT COUNT(1) FROM checkers WHERE file = ${mysql.escape(msg.content.id)};`);
                            if (rows[0]['COUNT(1)'] <= 0) await sql.query(`INSERT INTO checkers (file, description) VALUES (${mysql.escape(msg.content.id)}, ${mysql.escape(msg.content.description)});`);
                            await saveChecker(msg.content.id, msg.content.description)
                        } else {
                            try {
                                await fs.unlink(`grading/checkers/${msg.content.id}.cpp`);
                            } catch (e) { }
                        }
                    } else if (msg.content.result.result === 'AC') saveChecker(msg.content.id, msg.content.description);
                    if (checkerSocket[msg.content.id]) io.to(checkerSocket[msg.content.id]).emit('updt', {
                        result: msg.content.result
                    });
                } else if (msg.content.type === 'grading') {
                    const body = msg.content.body;
                    if (msg.content.result.result === 'AC') {
                        var subtask = [ ], languages = [ ];
                        for (var i = 0; i < body.subtaskCnt; i++) {
                            var hierarchy = [ ];
                            for (var j = 0; ; j++) {
                                if (body[`${i}-${j}hierarchy`] === undefined) break;
                                if (body[`${i}-${j}hierarchyEnabled`] === 'true') hierarchy.push(parseInt(body[`${i}-${j}hierarchy`]) - 1);
                            }
                            subtask.push({
                                tl: body[`${i}tl`],
                                wl: body[`${i}wl`],
                                ml: body[`${i}ml`],
                                hierarchy: hierarchy,
                                dataset: body[`${i}dataset`],
                                regex: body[`${i}regex`],
                                validator: body[`${i}validator`],
                                checker: body[`${i}checker`],
                                marks: body[`${i}marks`]
                            });
                        }
                        for (var i = 0; i < body.languagesCnt; i++) {
                            var submittings = [ ], necessaries = [ ];
                            for (var j = 0; ; j++) {
                                if (body[`${i}-${j}submitting`] === undefined) break;
                                if (body[`${i}-${j}submittingEnabled`] === 'true') submittings.push(body[`${i}-${j}submitting`]);
                            }
                            for (var j = 0; ; j++) {
                                if (body[`${i}-${j}helper`] === undefined) break;
                                if (body[`${i}-${j}helperEnabled`] === 'true') necessaries.push(body[`${i}-${j}helper`]);
                            }
                            languages.push({
                                lang: body[`${i}lang`],
                                args: body[`${i}args`],
                                submittings: submittings,
                                sample: body[`${i}sample`].replace(/\r/g, ''),
                                necessaries: necessaries,
                                test: (body[`${i}test`] ? true : false)
                            });
                        }
                        var grading = {
                            gradable: (body.gradable ? true : false),
                            subtask: subtask,
                            languages: languages
                        };
                        await fs.writeFile(`archive/${msg.content.problem}/grading.json`, JSON.stringify(grading));
                    }
                    if (gradingSocket[msg.content.id]) io.to(gradingSocket[msg.content.id]).emit('updt', {
                        result: msg.content.result
                    });
                } else if (msg.content.type === 'test') {
                    var k = -1;
                    for (idx in testSocket) if (testSocket[idx].to === msg.content.id) k = idx;
                    if (k == -1) return;
                    for (var i = 0; i < msg.content.submittings.length; i++) {
                        try {
                            await fs.unlink(`grading/submissions/${msg.content.id}-${msg.content.submittings[i]}`);
                        } catch (e) { }
                    }
                    io.to(testSocket[k].id).emit('updt', {
                        result: msg.content.result
                    });
                    delete testSocket[k];
                }
            }
        });
    }
    (async function () {
        sql = await mysql.createPool({
            host: '127.0.0.1',
            user: 'ogs',
            password: sqlpw,
            database: 'ogs',
            waitForConnections: true,
            enableKeepAlive: true
        });
        await sql.query('CREATE TABLE IF NOT EXISTS users (cnt INT UNIQUE NOT NULL AUTO_INCREMENT, user VARCHAR(100) PRIMARY KEY, password VARCHAR(100) NOT NULL, registerDate DATETIME DEFAULT CURRENT_TIMESTAMP, admin BOOLEAN NOT NULL DEFAULT FALSE);');
        await sql.query('CREATE TABLE IF NOT EXISTS problems (title VARCHAR(100) NOT NULL, num VARCHAR(100) PRIMARY KEY, submitCnt INT NOT NULL DEFAULT 0, correctCnt INT NOT NULL Default 0);');
        await sql.query('CREATE TABLE IF NOT EXISTS redirections (num VARCHAR(100) PRIMARY KEY, href VARCHAR(100) NOT NULL);');
        await sql.query('CREATE TABLE IF NOT EXISTS submissions (cnt INT UNIQUE NOT NULL AUTO_INCREMENT, id CHAR(64) PRIMARY KEY, user VARCHAR(100) NOT NULL, result VARCHAR(5), marks DOUBLE, problem VARCHAR(100) NOT NULL, lang VARCHAR(100) NOT NULL, time DOUBLE, walltime DOUBLE, memory DOUBLE, submitDate DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (user) REFERENCES users(user), FOREIGN KEY (problem) REFERENCES problems(num));');
        await sql.query('CREATE TABLE IF NOT EXISTS subtasks (id CHAR(64) NOT NULL, subtask INT NOT NULL, result VARCHAR(5), marks DOUBLE, time DOUBLE, walltime DOUBLE, mem DOUBLE, FOREIGN KEY (id) REFERENCES submissions(id), PRIMARY KEY (id, subtask));');
        if ((await sql.query('SELECT COUNT(1) FROM INFORMATION_SCHEMA.STATISTICS WHERE table_schema=DATABASE() AND table_name=\'submissions\' AND index_name=\'problemIndex\''))[0][0]['COUNT(1)'] <= 0) await sql.query('CREATE INDEX problemIndex ON submissions (problem);');
        await sql.query('CREATE TABLE IF NOT EXISTS histories (cnt INT UNIQUE NOT NULL AUTO_INCREMENT, problem VARCHAR(100) NOT NULL, user VARCHAR(100) NOT NULL, type CHAR(6) NOT NULL DEFAULT \'UNKNWN\', arg VARCHAR(100), date DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (user) REFERENCES users(user));');
        if ((await sql.query('SELECT COUNT(1) FROM INFORMATION_SCHEMA.STATISTICS WHERE table_schema=DATABASE() AND table_name=\'histories\' AND index_name=\'problemIndex\';'))[0][0]['COUNT(1)'] <= 0) await sql.query('CREATE INDEX problemIndex ON histories (problem);');
        await sql.query('CREATE TABLE IF NOT EXISTS checkers (file VARCHAR(100) PRIMARY KEY, description VARCHAR(500));');
        await loadCheckers();
        await loadProblems();
        console.log('SQL config done');

        (async function resolveQuerires() {
            while (queries.length > 0) {
                await sql.query(queries[0]);
                queries.shift();
            }
            setTimeout(resolveQuerires, 1000);
        })();
    })();
})();

async function loadCheckers() {
    var content = { checkers: { }};
    try {
        content = JSON.parse(await fs.readFile('grading/checkers.json'));
    } catch (e) { }
    for (file in content.checkers) {
        const desc = content.checkers[file];
        if ((await sql.query(`SELECT COUNT(1) FROM checkers WHERE file = ${mysql.escape(file)};`))[0][0]['COUNT(1)'] >= 1) {
            await sql.query(`UPDATE checkers SET description = ${mysql.escape(desc)} WHERE file = ${mysql.escape(file)};`);
        } else {
            await sql.query(`INSERT INTO checkers (file, description) VALUES (${mysql.escape(file)}, ${mysql.escape(desc)});`);
        }
    }
}

async function saveChecker(file, desc) {
    var content = { checkers: { }};
    try {
        content = JSON.parse(await fs.readFile('grading/checkers.json'));
    } catch (e) { }
    content.checkers[file] = desc;
    await fs.writeFile('grading/checkers.json', JSON.stringify(content));
    if ((await sql.query(`SELECT COUNT(1) FROM checkers WHERE file = ${mysql.escape(file)};`))[0][0]['COUNT(1)'] >= 1) {
        await sql.query(`UPDATE checkers SET description = ${mysql.escape(desc)} WHERE file = ${mysql.escape(file)};`);
    } else {
        await sql.query(`INSERT INTO checkers (file, description) VALUES (${mysql.escape(file)}, ${mysql.escape(desc)});`);
    }
}

async function removeChecker(file) {
    var content = { checkers: { }};
    try {
        content = JSON.parse(await fs.readFile('grading/checkers.json'));
    } catch (e) { }
    delete content.checkers[file];
    await fs.writeFile('grading/checkers.json', JSON.stringify(content));
    await sql.query(`DELETE FROM checkers WHERE file = ${mysql.escape(file)}`);
}

async function loadProblems() {
    var content = { problems: { }, redirections: { } };
    try {
        content = JSON.parse(await fs.readFile('archive/problems.json'));
    } catch (e) { }
    for (num in content.problems) {
        const problem = content.problems[num];
        if ((await sql.query(`SELECT COUNT(1) FROM problems WHERE num = ${mysql.escape(num)};`))[0][0]['COUNT(1)'] >= 1) {
            await sql.query(`UPDATE problems SET title = ${mysql.escape(problem.title)} WHERE num = ${mysql.escape(num)};`);
        } else {
            await sql.query(`INSERT INTO problems (num, title) VALUES (${mysql.escape(num)}, ${mysql.escape(problem.title)});`);
        }
        if ((await sql.query(`SELECT COUNT(1) FROM redirections WHERE num = ${mysql.escape(num)};`))[0][0]['COUNT(1)'] >= 1) {
            await sql.query(`DELETE FROM redirections WHERE num = ${mysql.escape(num)};`);
        }
    }
    for (num in content.redirections) {
        const problem = content.redirections[num];
        if ((await sql.query(`SELECT COUNT(1) FROM problems WHERE num = ${mysql.escape(num)};`))[0][0]['COUNT(1)'] >= 1) {
            await sql.query(`DELETE FROM problems WHERE num = ${mysql.escape(num)};`);
        }
        if ((await sql.query(`SELECT COUNT(1) FROM redirections WHERE num = ${mysql.escape(num)};`))[0][0]['COUNT(1)'] >= 1) {
            await sql.query(`UPDATE redirections SET href = ${mysql.escape(problem.href)} WHERE num = ${mysql.escape(num)};`);
        } else {
            await sql.query(`INSERT INTO redirections (num, href) VALUES (${mysql.escape(num)}, ${mysql.escape(problem.href)});`);
        }
    }
    const [ rows1, fields1 ] = await sql.query(`SELECT num FROM problems;`);
    const [ rows2, fields2 ] = await sql.query(`SELECT num FROM redirections;`);
    for (idx in rows1) {
        const num = rows1[idx].num;
        if (!(num in content.problems)) await sql.query(`DELETE FROM problems WHERE num = ${mysql.escape(num)};`);
    }
    for (idx in rows2) {
        const num = rows2[idx].num;
        if (!(num in content.redirections)) await sql.query(`DELETE FROM redirections WHERE num = ${mysql.escape(num)};`);
    }
}

async function saveProblem(num, newProb) {
    var content = { problems: { }, redirections: { } };
    try {
        content = JSON.parse(await fs.readFile('archive/problems.json'));
    } catch (e) { }
    delete content.redirections[num];
    content.problems[num] = newProb;
    await fs.writeFile('archive/problems.json', JSON.stringify(content));
    if ((await sql.query(`SELECT COUNT(1) FROM problems WHERE num = ${mysql.escape(num)};`))[0][0]['COUNT(1)'] >= 1) {
        await sql.query(`UPDATE problems SET title = ${mysql.escape(newProb.title)} WHERE num = ${mysql.escape(num)};`);
    } else {
        await sql.query(`INSERT INTO problems (num, title) VALUES (${mysql.escape(num)}, ${mysql.escape(newProb.title)});`);
    }
    if ((await sql.query(`SELECT COUNT(1) FROM redirections WHERE num = ${mysql.escape(num)};`))[0][0]['COUNT(1)'] >= 1) {
        await sql.query(`DELETE FROM redirections WHERE num = ${mysql.escape(num)};`);
    }
}

async function saveRedirection(num, newRedr) {
    var content = { problems: { }, redirections: { } };
    try {
        content = JSON.parse(await fs.readFile('archive/problems.json'));
    } catch (e) { }
    delete content.problems[num];
    content.redirections[num] = newRedr;
    await fs.writeFile('archive/problems.json', JSON.stringify(content));
    if ((await sql.query(`SELECT COUNT(1) FROM problems WHERE num = ${mysql.escape(num)};`))[0][0]['COUNT(1)'] >= 1) {
        await sql.query(`DELETE FROM problems WHERE num = ${mysql.escape(num)};`);
    }
    if ((await sql.query(`SELECT COUNT(1) FROM redirections WHERE num = ${mysql.escape(num)};`))[0][0]['COUNT(1)'] >= 1) {
        await sql.query(`UPDATE redirections SET href = ${mysql.escape(newRedr.href)} WHERE num = ${mysql.escape(num)};`);
    } else {
        await sql.query(`INSERT INTO redirections (num, href) VALUES (${mysql.escape(num)}, ${mysql.escape(newRedr.href)});`);
    }
}

async function removeProblem(num) {
    var content = { problems: { }, redirections: { }};
    try {
        content = JSON.parse(await fs.readFile('archive/problems.json'));
    } catch (e) { }
    delete content.problems[num];
    delete content.redirections[num];
    await fs.writeFile('archive/problems.json', JSON.stringify(content));
    await sql.query(`DELETE FROM problems WHERE num = ${mysql.escape(num)}`);
    await sql.query(`DELETE FROM redirections WHERE num = ${mysql.escape(num)}`);
}

function getHistory(title, user, type, arg) {
    if (type === 'CRTPRB') return `${user} created new problem ${title}`;
    else if (type === 'CRTRDR') return `${user} created new redirection ${title} → ${arg}`;
    else if (type === 'EDTPRB') return `${user} edited the problem ${title}`;
    else if (type === 'CRTDSC') return `${user} added the description ${arg} to the problem ${title}`;
    else if (type === 'EDTDSC') return `${user} edited the description ${arg} of the problem ${title}`;
    else if (type === 'RMVDSC') return `${user} removed the description ${arg} from the problem ${title}`;
    else if (type === 'CRTSOL') return `${user} added the solution ${arg} to the problem ${title}`;
    else if (type === 'EDTSOL') return `${user} edited the solution ${arg} of the problem ${title}`;
    else if (type === 'RMVSOL') return `${user} removed the solution ${arg} from the problem ${title}`;
    else if (type === 'EDTTTL') return `${user} renamed the problem ${title} → now ${arg}`;
    else if (type === 'RMVPRB') return `${user} removed the problem ${title}`;
    else if (type === 'RMVRDR') return `${user} removed the redirection ${title}`;
    else if (type === 'EDTEXP') return `${user} edited examples of the problem ${title}`;
    else if (type === 'ODRREV') return `${user} ordered reevaluation on the problem ${title}`;
    else if (type === 'RMOVED') return `${user} moved the problem ${title} → now redirection towards ${arg}`;
    else if (type === 'LMOVED') return `${user} moved the problem ${title} → ${arg}`;
    else if (type === 'CRTPRV') return `${user} registered new providing ${arg} to the problem ${title}`;
    else if (type === 'RMVPRV') return `${user} removed the providing ${arg} from the problem ${title}`;
    else if (type === 'EDTPRV') return `${user} edited the providing ${arg} of the problem ${title}`;
    else return `${user} triggered ${type} to the problem ${title}`;
}

async function addHistory(num, user, type, arg, diff) {
    await sql.query(`INSERT INTO histories (problem, user, type, arg) VALUES (${mysql.escape(num)}, ${mysql.escape(user)}, ${mysql.escape(type)}, ${arg ? mysql.escape(arg) : '\'\''});`);
    const [ rows, fields ] = await sql.query(`SELECT LAST_INSERT_ID();`);
    const id = rows[0]['LAST_INSERT_ID()'];
    await fs.writeFile(`changelog/${id}`, JSON.stringify(diff));
}

function makeExamples(examples, input, output) {
    var exp_md = '</div>';
    for (var i = 0; i < examples.length; i++) if (examples[i].use) exp_md += `<div class="examplewrap"><div class="example"><div class="input"><div class="marked">## ${input}${i + 1}</div><div class="marked code">${examples[i].input}</div></div><div class="output"><div class="marked">## ${output}${i + 1}</div><div class="marked code">${examples[i].output}</div></div></div></div><div class="marked">${examples[i].desc}</div>`;
    exp_md += '<div class="marked">';
    return exp_md;
}

function replaceExamples(content, examples) {
    const matches = [ ...content.matchAll('\\[\\[examples:.*:.*\\]\\]') ];
    matches.forEach(function (item) {
        const cont = item.toString();
        var inner = cont.substr(2, cont.length - 4).split(':');
        content = content.replace(cont, makeExamples(examples, inner[1], inner[2]));
    });
    return content;
}

function erase(x) {
    if (socketList[x] === undefined) return;
    if (socketList[x].id) {
        if (socketList[x].type === 'execute' && idSockets[socketList[x].id]) {
            var k = idSockets[socketList[x].id].indexOf(x);
            if (k != -1) idSockets[socketList[x].id].splice(k, 1);
            if (idSockets[socketList[x].id].length == 0) delete idSockets[socketList[x].id];
        }
        if (socketList[x].type === 'checker') delete checkerSocket[socketList[x].id];
        if (socketList[x].type === 'grading') delete gradingSocket[socketList[x].id];
        if (socketList[x].type === 'test') delete testSocket[socketList[x].id];
    }
    delete socketList[x].id;
}

io.on('connection', function (socket) {
    socketList[socket.id] = {
        time: Date.now()
    };
    socket.on('disconnect', function () {
        erase(socket.id);
        if (socketList[socket.id] !== undefined) delete socketList[socket.id];
    });
    socket.on('id', async function (data) {
        erase(socket.id);
        if (data.type === 'execute') {
            if (socketList[socket.id].id) return;
            socketList[socket.id].id = data.id;
            socketList[socket.id].type = data.type;
            if (!idSockets[data.id]) idSockets[data.id] = [ ];
            if (!idSockets[data.id].includes(socket.id)) idSockets[data.id].push(socket.id);
            const [ rows, fields ] = await sql.query(`SELECT cnt, id, user, result, problem, time, memory, submitDate FROM submissions WHERE id = ${mysql.escape(data.id)};`);
            if (rows.length > 0) socket.emit('updt', {
                result: getResult(rows[0].result),
                time: rows[0].time,
                mem: rows[0].memory
            });
        } else if (data.type === 'checker') {
            if (socketList[socket.id].id) return;
            socketList[socket.id].id = data.id;
            socketList[socket.id].type = data.type;
            checkerSocket[data.id] = socket.id;
        } else if (data.type === 'grading') {
            if (socketList[socket.id].id) return;
            socketList[socket.id].id = data.id;
            socketList[socket.id].type = data.type;
            gradingSocket[data.id] = socket.id;
        } else if (data.type === 'test') {
            if (socketList[socket.id].id) return;
            socketList[socket.id].id = data.id;
            socketList[socket.id].type = data.type;
            if (testSocket[data.id] === undefined) testSocket[data.id] = { };
            testSocket[data.id].id = socket.id;
        }
    });
    socket.emit('hello');
});