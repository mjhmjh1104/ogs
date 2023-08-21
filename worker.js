const { Worker, parentPort, workerData } = require('worker_threads');
const data = workerData;
const fs = require('fs').promises;
const path = require('path');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const decompress = require('decompress');
const chmodr = require('chmodr');

var workingDir = null;

async function mkdir(path) {
    try {
        await fs.access(path);
    } catch (e) {
        await fs.mkdir(path, {
            recursive: true
        });
    }
}

(function initialize() {
    exec(`isolate/isolate --init --cg --box-id=${data.workerNum}`, async function (error, stdout, stderr) {
        if (error && stderr.includes('exist')) return exec(`isolate/isolate --cg --cleanup --box-id=${data.workerNum}`, function (error, stdout, stderr) {
            initialize();
        }); else if (error) {
            console.log(error);
            throw new Error ('Unable to start isolate');
        }
        workingDir = stdout;
        await mkdir(`grading/isolate/${data.workerNum}`);
        chmodr(`grading/isolate/${data.workerNum}`, 0o777, function (error) {
            if (error) {
                console.log(error);
                throw new Error ('Unable to start isolate');
            }
        });
        addBinding(path.join(__dirname, `grading/isolate/${data.workerNum}`), 'files', 'rw');
        parentPort.postMessage({
            workerNum: data.workerNum,
            data: 'load'
        });
    });
})();

var bindings = [ ];

function addBinding(from, to, options) {
    bindings.push({
        from: from,
        to: to,
        options: options
    });
}

async function isolateExec(command, options, timeout, wallTimeout, memlimit, procNum, meta) {
    var dir = '';
    for (idx in bindings) {
        if (bindings[idx].to) dir += ` --dir=${bindings[idx].to}=${bindings[idx].from}`;
        else dir += ` --dir=${bindings[idx].from}`;
        if (bindings[idx].options) dir += `:${bindings[idx].options}`
    }
    return await exec(`isolate/isolate --env=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin --meta=${meta} --run ${command} ${options}${dir} --box-id=${data.workerNum} --cg --cg-mem=${parseInt(memlimit / 1024) + 5 * 1024} --mem=${parseInt(memlimit / 1024) + 5 * 1024} --time=${timeout} --wall-time=${wallTimeout} --extra-time=${5} --processes=${procNum}`);
}

parentPort.on('message', async function (msg) {
    if (msg.data == 'grade') {
        parentPort.postMessage({
            workerNum: data.workerNum,
            data: 'busy'
        });
        if (msg.content.type === 'ioiSimple') {
            const res = await grade(msg.content);
            parentPort.postMessage({
                workerNum: data.workerNum,
                data: 'updt',
                content: {
                    id: msg.content.filename,
                    problem: msg.content.problem,
                    type: msg.content.type,
                    result: res
                }
            });
        } else if (msg.content.type === 'checker') {
            const res = await compile(msg.content);
            parentPort.postMessage({
                workerNum: data.workerNum,
                data: 'updt',
                content: {
                    id: msg.content.filename,
                    type: msg.content.type,
                    result: res,
                    description: msg.content.description
                }
            });
        }
        parentPort.postMessage({
            workerNum: data.workerNum,
            data: 'free'
        });
    }
});

function tmpResult(res, id, type) {
    parentPort.postMessage({
        workerNum: data.workerNum,
        data: 'updt',
        content: {
            id: id,
            result: res,
            type: type
        }
    });
}

async function getLog(log, legend) {
    const content = await fs.readFile(log);
    const lt = content.toString().match(new RegExp(`${legend}:|.+`, 'g'));
    if (!lt || lt.length == 0) return null;
    var k = lt.indexOf(legend + ':');
    if (k == -1 || k + 1 >= lt.length) return null;
    return lt[k + 1];
}

async function grade(submission) {
    const COMPILE_CHECKER_LOG = `grading/isolate/${data.workerNum}/compile_checker.log`;
    const COMPILE_LOG = `grading/isolate/${data.workerNum}/compile.log`;
    const EXEC_LOG = `grading/isolate/${data.workerNum}/exec.log`;
    const CHECK_LOG = `grading/isolate/${data.workerNum}/check.log`;
    var totaltime = 0;
    var totalwalltime = 0;
    var totalmem = 0;
    var timeConsumed = 0, lastTimeConsumed = 0;
    var r = 'AC';
    try {
        tmpResult({
            result: 'RD',
            done: 0
        }, submission.filename, submission.type);
        await exec(`yes | rm -rf grading/isolate/"${data.workerNum}"/*`);
        await exec(`cp "grading/compilers/c++20.sh" "grading/isolate/${data.workerNum}/compile.sh"`);
        await exec(`cp "grading/submissions/${submission.filename}" "grading/isolate/${data.workerNum}/submission.cpp"`);
        await exec(`cp "grading/checkers/diff.cpp" "grading/isolate/${data.workerNum}/checker.cpp"`);
        tmpResult({
            result: 'CP',
            done: 0
        }, submission.filename, submission.type);
        try {
            await isolateExec('/files/compile.sh', '/files/checker.cpp /files/checker', 10, 21, 512 * 1024 * 1024, 1000, COMPILE_CHECKER_LOG);
        } catch (e) {
            return {
                result: 'FL'
            };
        }
        try {
            await isolateExec('/files/compile.sh', '/files/submission.cpp /files/exec', 10, 21, 512 * 1024 * 1024, 1000, COMPILE_LOG);
        } catch (e) {
            const status = await getLog(COMPILE_LOG, 'status');
            if (status == 'TO') return {
                result: 'CL'
            };
            if (status == 'SG') return {
                result: 'CR'
            };
            if (status == 'XX') return {
                result: 'FL'
            };
            return {
                result: 'CE'
            };
        }
        tmpResult({
            result: 'FD',
            done: 0
        }, submission.filename, submission.type);
        await decompress(`archive/${submission.problem}/data.zip`, `grading/isolate/${data.workerNum}/archive`);
        await exec(`cp "archive/${submission.problem}/info.json" "grading/isolate/${data.workerNum}/archive/info.json"`);
        const info = JSON.parse(await fs.readFile(`grading/isolate/${data.workerNum}/archive/info.json`));
        tmpResult({
            result: 'GD',
            done: 0
        }, submission.filename, submission.type);
        for (idx in info.data) {
            const curr = parseInt(idx);
            var cnt = info.data[idx];
            try {
                const { stdout, stderr } = await isolateExec('/files/exec', `--stdin=/files/archive/data/${cnt}.in --stdout=/files/out --stderr=/files/err`, info.tl / 1000, info.wl / 1000, info.ml, 1, EXEC_LOG);
            } catch (e) { }
            const status = await getLog(EXEC_LOG, 'status');
            const time = parseFloat(await getLog(EXEC_LOG, 'time')) * 1000;
            const walltime = parseFloat(await getLog(EXEC_LOG, 'time-wall')) * 1000;
            const mem = parseFloat(await getLog(EXEC_LOG, 'cg-mem')) * 1024;
            totaltime = Math.max(totaltime, time);
            totalwalltime = Math.max(totalwalltime, walltime);
            totalmem = Math.max(totalmem, mem);
            if (totaltime > info.tl) return {
                result: 'TL'
            };
            if (totalwalltime > info.wl) return {
                result: 'WL'
            };
            if (totalmem > info.ml) return {
                result: 'ML'
            };
            if (status == 'XX') return {
                result: 'FL'
            };
            if (status == 'RE') return {
                result: 'RE'
            };
            if (status == 'SG') return {
                result: 'SD'
            };
            if (status == 'TO') return {
                result: 'TL'
            };
            if (parseInt(await getLog(EXEC_LOG, 'killed')) == 1) return {
                result: 'SD'
            };
            try {
                const res = await isolateExec('/files/checker', `/files/archive/data/${cnt}.out /files/out`, 10, 21, 512 * 1024 * 1024, 1000, CHECK_LOG);
                if (res.stdout === 'WA') r = 'WA';
                else if (res.stdout !== 'AC') return {
                    result: res.stdout
                };
            } catch (e) {
                return {
                    result: 'CD'
                };
            }
            timeConsumed += walltime;
            if (timeConsumed > lastTimeConsumed + 500) {
                lastTimeConsumed = timeConsumed;
                tmpResult({
                    result: 'GD',
                    done: (curr + 1) / info.data.length
                }, submission.filename, submission.type);
            }
        }
    } catch (e) {
        console.log(e);
        return {
            result: 'FL'
        };
    }
    return {
        result: r,
        time: totaltime,
        walltime: totalwalltime,
        mem: totalmem
    };
}

async function compile(submission) {
    const COMPILE_CHECKER_LOG = `grading/isolate/${data.workerNum}/compile_checker.log`;
    var r = 'AC';
    try {
        await exec(`yes | rm -rf grading/isolate/"${data.workerNum}"/*`);
        await exec(`cp "grading/compilers/c++20.sh" "grading/isolate/${data.workerNum}/compile.sh"`);
        await exec(`cp "grading/checkers/${submission.filename}.cpp" "grading/isolate/${data.workerNum}/checker.cpp"`);
        try {
            await isolateExec('/files/compile.sh', '/files/checker.cpp /files/checker --stderr=/files/compile.out', 10, 21, 512 * 1024 * 1024, 1000, COMPILE_CHECKER_LOG);
        } catch (e) {
            return {
                result: 'FL',
                log: (await fs.readFile(`grading/isolate/${data.workerNum}/compile.out`)).toString()
            };
        }
    } catch (e) {
        console.log(e);
        return {
            result: 'FL'
        };
    }
    return {
        result: r
    };
}