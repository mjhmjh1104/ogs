const { Worker, parentPort, workerData } = require('worker_threads');
const data = workerData;
const { execSync } = require("child_process");

parentPort.postMessage({
    workerNum: data.workerNum,
    data: 'load'
});

parentPort.on('message', function (msg) {
    console.log('From parent: ' + JSON.stringify(msg));
    if (msg.data == 'grade') {
        grade(msg.content);
    }
});

function grade(submission) {
    execSync(`grading/compilers/c++20.sh grading/submissions/${submission.filename} grading/compiled/${data.workerNum}`);
}