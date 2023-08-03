const express = require('express');
const app = express();
const http = require('http').Server(app);
const path = require('path');
const bodyParser = require('body-parser');
const { Worker } = require('worker_threads');
const fs = require('fs').promises;
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const { sqlpw } = require('./config.json');
var io = require('socket.io')(http);

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

app.get('/', async function (req, res) {
    const content = JSON.parse(await fs.readFile('archive/problems.json')).problems;
    return res.render('main', {
        problems: content
    });
});

app.get('/detail/:id', async function (req, res) {
    const [ rows, fields ] = await sql.query(`SELECT cnt, id, user, result, problem, time, memory FROM submissions WHERE id = '${req.params.id}'`);
    if (rows.length == 0) return res.send('Not Found');
    const code = await fs.readFile(`grading/submissions/${req.params.id}`);
    return res.render('submission', {
        code: code.toString(),
        submission: rows[0],
        result: getResult(rows[0].result),
    });
});

app.get('/:num', async function (req, res) {
    try {
        await fs.access(`archive/${req.params.num}`);
    } catch (e) {
        return res.send('Not Found');
    }
    const info = JSON.parse(await fs.readFile(`archive/${req.params.num}/info.json`));
    const content = await fs.readFile(`archive/${req.params.num}/description.md`);
    return res.render('problem', {
        num: req.params.num,
        info: info,
        content: content.toString()
    });
});

app.get('/:num/submit', async function (req, res) {
    try {
        await fs.access(`archive/${req.params.num}`);
    } catch (e) {
        return res.send('Not Found');
    }
    const title = JSON.parse(await fs.readFile(`archive/${req.params.num}/info.json`)).title;
    return res.render('submit', {
        num: req.params.num,
        title: title
    });
});

app.get('/:num/submissions', async function (req, res) {
    try {
        await fs.access(`archive/${req.params.num}`);
    } catch (e) {
        return res.send('Not Found');
    }
    const title = JSON.parse(await fs.readFile(`archive/${req.params.num}/info.json`)).title;
    const [ rows, fields ] = await sql.query(`SELECT cnt, id, user, result, problem, time, memory FROM submissions WHERE problem = '${req.params.num}' ORDER BY cnt DESC;`);
    return res.render('list', {
        title: title,
        num: req.params.num,
        submissions: rows,
        getResult: getResult
    });
});

app.post('/:num/submit', async function (req, res) {
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
        user: req.body.user,
        problem: req.params.num
    });
    await sql.query(`INSERT INTO submissions (id, user, problem) VALUES ('${id}', '${req.body.user}', '${req.params.num}')`);
    tryGrading();
    res.redirect(`/detail/${id}`);
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
    if (x == 'GD') return 'Marking';
    return 'Unknown';
}

app.get('*', function (req, res) {
    return res.send('Not Found');
});

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
                await sql.query(`UPDATE submissions SET result = '${msg.content.result.result}' WHERE id = '${msg.content.id}'`);
                if (msg.content.result.time !== undefined) await sql.query(`UPDATE submissions SET time = ${msg.content.result.time} WHERE id = '${msg.content.id}'`);
                if (msg.content.result.mem !== undefined) await sql.query(`UPDATE submissions SET memory = ${msg.content.result.mem} WHERE id = '${msg.content.id}'`);
                if (idSockets[msg.content.id]) idSockets[msg.content.id].forEach(function (item, index, object) {
                    if (Date.now() - socketList[item].time > 24 * 60 * 60 * 1000) object.splice(index, 1);
                    io.to(item).emit('updt', {
                        result: getResult(msg.content.result.result),
                        time: msg.content.result.time,
                        mem: msg.content.result.mem
                    });
                });
            }
        });
    }
    // id, user, result, marks
    (async function () {
        sql = await mysql.createConnection({
            host: '127.0.0.1',
            user: 'ogs',
            password: sqlpw,
            database: 'ogs'
        });
        await sql.query('CREATE TABLE IF NOT EXISTS submissions (cnt INT UNIQUE NOT NULL AUTO_INCREMENT, id CHAR(64) PRIMARY KEY, user VARCHAR(100) NOT NULL, result VARCHAR(5), marks INT, problem INT NOT NULL, time DOUBLE, memory DOUBLE);');
        console.log('SQL config done');
    })();
})();

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
        const [ rows, fields ] = await sql.query(`SELECT cnt, id, user, result, problem, time, memory FROM submissions WHERE id = '${data}'`);
        if (rows.length > 0) socket.emit('updt', {
            result: getResult(rows[0].result),
            time: rows[0].time,
            mem: rows[0].memory
        });
    })
    socket.emit('hello');
});