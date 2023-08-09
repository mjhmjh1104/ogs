const express = require('express');
const session = require('express-session');
const app = express();
const http = require('http').Server(app);
const path = require('path');
const bodyParser = require('body-parser');
const { Worker } = require('worker_threads');
const fs = require('fs').promises;
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const { sqlpw, sessSecret, salt } = require('./config.json');
const io = require('socket.io')(http);
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');

var sql = null;

// List of connected auto-refreshing pages
var socketList = { };
var idSockets = { };

// Queue storing submission IDs
var queue = [ ];

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

app.set('view engine', 'ejs');
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({
    extended: true
}));
app.use(session({
    key: 'auth',
    secret: sessSecret,
    resave: false,
    saveUninitialized: true,
    cookie: {
        expires: 60 * 60 * 24 * 7
    }
}));
app.use(cookieParser());

app.get('/', async function (req, res) {
    const [ rows, fields ] = await sql.query(`SELECT * FROM problems;`);
    return res.render('main', {
        problems: rows,
        user: req.session.auth
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
    await sql.query(`INSERT INTO users (user, password) VALUES (${mysql.escape(req.body.user)}, '${hashedPassword}')`);
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
    const [ rows, fields ] = await sql.query(`SELECT cnt, id, user, result, problem, time, memory, submitDate FROM submissions WHERE id = ${mysql.escape(req.params.id)};`);
    if (rows.length == 0) return res.send('Not Found');
    const code = await fs.readFile(`grading/submissions/${req.params.id}`);
    return res.render('submission', {
        code: code.toString(),
        submission: rows[0],
        result: getResult(rows[0].result),
        user: req.session.auth
    });
});

app.post('/detail/:id/delete', async function (req, res) {
    const [ rows, fields ] = await sql.query(`SELECT user, result, problem FROM submissions WHERE id = ${mysql.escape(req.params.id)};`);
    if (rows.length == 0) return res.send('Not Found');
    if (!req.session.auth) return res.redirect(`/detail/${req.params.id}`);
    if (!req.session.auth.admin && req.session.auth.user !== rows[0].user) return req.redirect(`/detail/${req.params.id}`);
    await sql.query(`DELETE FROM submissions WHERE id = ${mysql.escape(req.params.id)};`);
    if (rows[0].result === 'AC') await sql.query(`UPDATE problems SET correctCnt = correctCnt - 1 WHERE num = ${mysql.escape(rows[0].problem)};`);
    await sql.query(`UPDATE problems SET submitCnt = submitCnt - 1 WHERE num = ${mysql.escape(rows[0].problem)};`);
    res.redirect(`/submissions/${rows[0].problem}`)
});

app.get('/view/:num', async function (req, res) {
    const [ rows, fields ] = await sql.query(`SELECT submitCnt, correctCnt FROM problems WHERE num = ${mysql.escape(req.params.num)}`);
    if (rows.length == 0) return res.send('Not Found');
    const info = JSON.parse(await fs.readFile(`archive/${req.params.num}/info.json`));
    const content = await fs.readFile(`archive/${req.params.num}/description.md`);
    return res.render('problem', {
        num: req.params.num,
        info: info,
        infoSql: rows[0],
        content: content.toString()
    });
});

app.get('/submit/:num', async function (req, res) {
    if (!req.session.auth) return res.redirect('/signin');
    try {
        await fs.access(`archive/${req.params.num}`);
    } catch (e) {
        return res.send('Not Found');
    }
    const title = JSON.parse(await fs.readFile(`archive/${req.params.num}/info.json`)).title;
    return res.render('submit', {
        num: req.params.num,
        title: title,
        user: req.session.auth
    });
});

app.get('/submissions/:num', async function (req, res) {
    try {
        await fs.access(`archive/${req.params.num}`);
    } catch (e) {
        return res.send('Not Found');
    }
    const title = JSON.parse(await fs.readFile(`archive/${req.params.num}/info.json`)).title;
    const [ rows, fields ] = await sql.query(`SELECT cnt, id, user, result, problem, time, memory, submitDate FROM submissions WHERE problem = ${mysql.escape(req.params.num)} ORDER BY cnt DESC;`);
    return res.render('list', {
        title: title,
        num: req.params.num,
        submissions: rows,
        getResult: getResult
    });
});

app.post('/submit/:num', async function (req, res) {
    if (!req.session.auth) return res.redirect('/signin');
    try {
        await fs.access(`archive/${req.params.num}`);
    } catch (e) {
        return res.send('Not Found');
    }
    const id = genID();
    await fs.writeFile(`grading/submissions/${id}`, req.body.code);
    queue.push({
        filename: id,
        time: Date.now(),
        user: req.session.auth.user,
        problem: req.params.num
    });
    await sql.query(`INSERT INTO submissions (id, user, problem) VALUES ('${id}', '${req.session.auth.user}', ${mysql.escape(req.params.num)})`);
    await sql.query(`UPDATE problems SET submitCnt = submitCnt + 1 WHERE num = ${mysql.escape(req.params.num)};`);
    tryGrading();
    res.redirect(`/detail/${id}`);
});

app.get('/:num', function (req, res) {
    return res.redirect(`/view/${req.params.num}`);
})

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
    return 'Unknown';
}

var port = 3000;
http.listen(port, function (req, res) {
    console.log('HTTP is listening on port ' + port);
});

(function initialize() {
    for (var i = 0; i < 3; i++) {
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
                var done = 1;
                if (msg.content.result.done !== undefined) done = msg.content.result.done;
                if (msg.content.result.result == 'AC') {
                    const [ rows, fields ] = await sql.query(`SELECT result FROM submissions WHERE id = '${msg.content.id}';`);
                    if (rows.length > 0 && rows[0].result !== 'AC') await sql.query(`UPDATE problems SET correctCnt = correctCnt + 1 WHERE num = ${mysql.escape(msg.content.problem)};`);
                }
                await sql.query(`UPDATE submissions SET result = '${msg.content.result.result}' WHERE id = '${msg.content.id}';`);
                if (msg.content.result.time !== undefined) await sql.query(`UPDATE submissions SET time = ${msg.content.result.time} WHERE id = '${msg.content.id}';`);
                if (msg.content.result.mem !== undefined) await sql.query(`UPDATE submissions SET memory = ${msg.content.result.mem} WHERE id = '${msg.content.id}';`);
                if (idSockets[msg.content.id]) idSockets[msg.content.id].forEach(function (item, index, object) {
                    if (Date.now() - socketList[item].time > 24 * 60 * 60 * 1000) object.splice(index, 1);
                    io.to(item).emit('updt', {
                        result: getResult(msg.content.result.result),
                        time: msg.content.result.time,
                        mem: msg.content.result.mem,
                        progress: done
                    });
                });
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
        await sql.query('CREATE TABLE IF NOT EXISTS problems (title VARCHAR(100) NOT NULL, num VARCHAR(100) PRIMARY KEY, submitCnt INT NOT NULL DEFAULT 0, correctCnt INT NOT NULL Default 0, gradingStyle VARCHAR(100) NOT NULL Default \'ungradable\');');
        await sql.query('CREATE TABLE IF NOT EXISTS redirections (num VARCHAR(100) PRIMARY KEY, href VARCHAR(100) NOT NULL);');
        await sql.query('CREATE TABLE IF NOT EXISTS submissions (cnt INT UNIQUE NOT NULL AUTO_INCREMENT, id CHAR(64) PRIMARY KEY, user VARCHAR(100) NOT NULL, result VARCHAR(5), marks INT, problem VARCHAR(100) NOT NULL, time DOUBLE, memory DOUBLE, submitDate DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (user) REFERENCES users(user), FOREIGN KEY (problem) REFERENCES problems(num));');
        if ((await sql.query('SELECT COUNT(1) FROM INFORMATION_SCHEMA.STATISTICS WHERE table_schema=DATABASE() AND table_name=\'submissions\' AND index_name=\'problemIndex\''))[0][0]['COUNT(1)'] <= 0) await sql.query('CREATE INDEX problemIndex ON submissions (problem);');
        await sql.query('CREATE TABLE IF NOT EXISTS histories (cnt INT UNIQUE NOT NULL AUTO_INCREMENT, problem VARCHAR(100) NOT NULL, user VARCHAR(100) NOT NULL, type CHAR(6) NOT NULL DEFAULT \'UNKNWN\', arg VARCHAR(100), date DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (user) REFERENCES users(user), FOREIGN KEY (problem) REFERENCES problems(num));');
        if ((await sql.query('SELECT COUNT(1) FROM INFORMATION_SCHEMA.STATISTICS WHERE table_schema=DATABASE() AND table_name=\'histories\' AND index_name=\'problemIndex\';'))[0][0]['COUNT(1)'] <= 0) await sql.query('CREATE INDEX problemIndex ON histories (problem);');
        await loadProblems();
        console.log('SQL config done');
    })();
})();

async function loadProblems() {
    const content = JSON.parse(await fs.readFile('archive/problems.json'));
    for (num in content.problems) {
        const problem = content.problems[num];
        if ((await sql.query(`SELECT COUNT(1) FROM problems WHERE num = ${mysql.escape(num)};`))[0][0]['COUNT(1)'] >= 1) {
            await sql.query(`UPDATE problems SET title = '${problem.title}', gradingStyle = '${problem.gradingStyle}' WHERE num = ${mysql.escape(num)};`);
        } else {
            await sql.query(`INSERT INTO problems (num, title, gradingStyle) values (${mysql.escape(num)}, '${problem.title}', '${problem.gradingStyle}');`);
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
            await sql.query(`UPDATE redirections SET href = '${problem.redirect}' WHERE num = ${mysql.escape(num)};`);
        } else {
            await sql.query(`INSERT INTO redirections (num, href) values (${mysql.escape(num)}, '${problem.redirect}');`);
        }
    }
}

async function saveProblem(num, newProb) {
    var content = JSON.parse(await fs.readFile('archive/problems.json'));
    delete content.redirections[num];
    content.problems[num] = newProb;
    await fs.writeFile('archive/problems.json', JSON.stringify(content));
    if ((await sql.query(`SELECT COUNT(1) FROM problems WHERE num = ${mysql.escape(num)};`))[0][0]['COUNT(1)'] >= 1) {
        await sql.query(`UPDATE problems SET title = '${newProb.title}', gradingStyle = '${newProb.gradingStyle}' WHERE num = ${mysql.escape(num)};`);
    } else {
        await sql.query(`INSERT INTO problems (num, title, gradingStyle) values (${mysql.escape(num)}, '${newProb.title}', '${newProb.gradingStyle}');`);
    }
    if ((await sql.query(`SELECT COUNT(1) FROM redirections WHERE num = ${mysql.escape(num)};`))[0][0]['COUNT(1)'] >= 1) {
        await sql.query(`DELETE FROM redirections WHERE num = ${mysql.escape(num)};`);
    }
}

async function saveRedirection(num, newRedr) {
    var content = JSON.parse(await fs.readFile('archive/problems.json'));
    delete content.problems[num];
    content.redirections[num] = newRedr;
    await fs.writeFile('archive/problems.json', JSON.stringify(content));
    if ((await sql.query(`SELECT COUNT(1) FROM problems WHERE num = ${mysql.escape(num)};`))[0][0]['COUNT(1)'] >= 1) {
        await sql.query(`DELETE FROM problems WHERE num = ${mysql.escape(num)};`);
    }
    if ((await sql.query(`SELECT COUNT(1) FROM redirections WHERE num = ${mysql.escape(num)};`))[0][0]['COUNT(1)'] >= 1) {
        await sql.query(`UPDATE redirections SET href = '${newRedr.redirect}' WHERE num = ${mysql.escape(num)};`);
    } else {
        await sql.query(`INSERT INTO redirections (num, href) values (${mysql.escape(num)}, '${newRedr.redirect}');`);
    }
}

async function removeProblem(num) {
    var content = JSON.parse(await fs.readFile('archive/problems.json'));
    delete content.problems[num];
    delete content.redirections[num];
    await fs.writeFile('archive/problems.json', JSON.stringify(content));
    await sql.query(`DELETE FROM problems WHERE num = ${mysql.escape(num)}`);
    await sql.query(`DELETE FROM redirections WHERE num = ${mysql.escape(num)}`);
}

io.on('connection', function (socket) {
    socketList[socket.id] = {
        time: Date.now()
    };
    socket.on('disconnect', function () {
        if (socketList[socket.id].id && idSockets[socketList[socket.id].id]) {
            var k = idSockets[socketList[socket.id].id].indexOf(socket.id);
            if (k != -1)idSockets[socketList[socket.id].id].splice(k, 1);
            if (idSockets[socketList[socket.id].id].length == 0) delete idSockets[socketList[socket.id].id];
        }
        delete socketList[socket.id];
    });
    socket.on('id', async function (data) {
        if (socketList[socket.id].id) return;
        socketList[socket.id].id = data;
        if (!idSockets[data]) idSockets[data] = [ ];
        if (!idSockets[data].includes(socket.id)) idSockets[data].push(socket.id);
        const [ rows, fields ] = await sql.query(`SELECT cnt, id, user, result, problem, time, memory, submitDate FROM submissions WHERE id = '${data}'`);
        if (rows.length > 0) socket.emit('updt', {
            result: getResult(rows[0].result),
            time: rows[0].time,
            mem: rows[0].memory
        });
    })
    socket.emit('hello');
});