const express = require('express');
const app = express();
const http = require('http').Server(app);
const path = require('path');
const bodyParser = require('body-parser');
const { Worker } = require('worker_threads');
const fs = require('fs');
const crypto = require('crypto');

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

app.get('/', function (req, res) {
    return res.render('main', {
        problems: [
            {
                title: 'A + B',
                type: 'i',
                num: '1'
            }
        ]
    });
});

app.get('/:num', function (req, res) {
    return res.render('problem', {
        num: '1',
        title: 'A + B',
        type: 'i',
        content: 'Give two non-negative integers A and B less than 10^9, print A + B as one integer.'
    });
});

app.get('/:num/submit', function (req, res) {
    return res.render('submit', {
        num: '1',
        title: 'A + B',
        type: 'i'
    });
});

app.post('/:num/submit', function (req, res) {
    const id = genID() + '.cpp';
    fs.writeFile(`grading/submissions/${id}`, req.body.code, function (err) {
        if (err) return res.send(`Error on proceesing your submission; Your submission ID: ${id}`);
        queue.push({
            filename: id,
            time: Date.now(),
            user: req.body.user
        });
        tryGrading();
        res.redirect(`/${req.params.num}/status`);
    });
});

app.get('/:num/status', function (req, res) {
    return res.send('Submitted');
})

app.get('*', function (req, res) {
    return res.send('Not Found');
});

var port = 3000;
http.listen(port, function (req, res) {
    console.log('HTTP is listening on port ' + port);
});

for (var i = 0; i < 3; i++) {
    var curr = new Worker (path.join(__dirname, 'worker'), {
        workerData: {
            workerNum: i
        }
    });
    workers.push({
        machine: curr,
        busy: false
    });

    curr.on('message', function (msg) {
        console.log('From worker: ' + JSON.stringify(msg));
        if (msg.data == 'free') {
            workers[msg.workerNum].bush = false;
            tryGrading();
        }
    });
}