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
    return await exec(`isolate/isolate --env=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin --meta=${meta} --run ${command} ${options}${dir} --box-id=${data.workerNum} --cg --cg-mem=${parseInt(memlimit / 1024) + 5 * 1024} --time=${timeout} --wall-time=${wallTimeout} --extra-time=${5} --processes=${procNum}`);
}

parentPort.on('message', async function (msg) {
    if (msg.data == 'grade') {
        parentPort.postMessage({
            workerNum: data.workerNum,
            data: 'busy'
        });
        if (msg.content.type === 'execute') {
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
        } else if (msg.content.type === 'grading') {
            const res = await grading(msg.content);
            parentPort.postMessage({
                workerNum: data.workerNum,
                data: 'updt',
                content: {
                    type: msg.content.type,
                    body: msg.content.body,
                    id: msg.content.id,
                    result: res,
                    problem: msg.content.problem
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

function getScore(pts, grading, subTotal, subSofar) {
    var score = 0;
    for (var i = 0; i < grading.subtask.length; i++) if (subTotal[i] === subSofar[i]) score += pts[i] * grading.subtask[i].marks;
    return score;
}

async function grade(submission) {
    const COMPILE_CHECKER_LOG = `grading/isolate/${data.workerNum}/compile_checker.log`;
    const COMPILE_LOG = `grading/isolate/${data.workerNum}/compile.log`;
    const EXEC_LOG = `grading/isolate/${data.workerNum}/exec.log`;
    const CHECK_LOG = `grading/isolate/${data.workerNum}/check.log`;
    var totaltime = 0;
    var totalwalltime = 0;
    var totalmem = 0;
    var r = [ ], pts = [ ], maxes = [ ];
    var grading = submission.grading;
    for (var i = 0; i < grading.subtask.length; i++) {
        r.push('AC');
        pts.push(1);
        maxes.push(grading.subtask[i].marks);
    }
    try {
        tmpResult({
            result: 'RD',
            done: 0
        }, submission.filename, submission.type);
        await exec(`yes | rm -rf grading/isolate/"${data.workerNum}"/*`);
        await exec(`cp "grading/compilers/${submission.lang}.sh" "grading/isolate/${data.workerNum}/compile.sh"`);
        await exec(`cp "grading/compilers/${submission.lang}-run.sh" "grading/isolate/${data.workerNum}/run.sh"`);
        await exec(`cp "grading/checker.sh" "grading/isolate/${data.workerNum}/compile-checker.sh"`);
        for (var i = 0; i < submission.submittings.length; i++) await exec(`cp "grading/submissions/${submission.filename}-${submission.submittings[i]}" "grading/isolate/${data.workerNum}/${submission.submittings[i]}"`);
        for (var i = 0; i < grading.subtask.length; i++) {
            const checker = grading.subtask[i].checker;
            var path = '';
            if ([...checker.matchAll('^checkers/')].length > 0) path = `grading/checkers/${checker.substr(9)}.cpp`;
            if ([...checker.matchAll('^helper/')].length > 0) path = `archive/${submission.problem}/helper/${checker.substr(7)}`;
            await exec(`cp "${path}" "grading/isolate/${data.workerNum}/checker${i}.cpp"`);
        }
        tmpResult({
            result: 'CP',
            done: 0
        }, submission.filename, submission.type);
        try {
            for (var i = 0; i < grading.subtask.length; i++) await isolateExec('/files/compile-checker.sh', `/files/checker${i} /files/checker${i}.cpp`, 10, 21, 4 * 1024 * 1024 * 1024, 1000, COMPILE_CHECKER_LOG);
        } catch (e) {
            return {
                result: 'FL'
            };
        }
        try {
            await isolateExec('/files/compile.sh', `${submission.args} --stderr=/files/compile.out`, 10, 21, 512 * 1024 * 1024, 1000, COMPILE_LOG);
        } catch (e) {
            var cpMessage = (await fs.readFile(`grading/isolate/${data.workerNum}/compile.out`)).toString();
            await exec(`cp "grading/isolate/${data.workerNum}/compile.out" "grading/messages/${submission.filename}"`);
            const status = await getLog(COMPILE_LOG, 'status');
            if (status == 'TO') return {
                result: 'CL',
                log: cpMessage
            };
            if (status == 'SG') return {
                result: 'CR',
                log: cpMessage
            };
            if (status == 'XX') return {
                result: 'FL',
                log: cpMessage
            };
            return {
                result: 'CE',
                log: cpMessage
            };
        }
        var cpMessage = (await fs.readFile(`grading/isolate/${data.workerNum}/compile.out`)).toString();
        await exec(`cp "grading/isolate/${data.workerNum}/compile.out" "grading/messages/${submission.filename}"`);
        tmpResult({
            result: 'FD',
            done: 0,
            log: cpMessage
        }, submission.filename, submission.type);
        var datasets = [ ];
        await mkdir(`grading/isolate/${data.workerNum}/archive`);
        await exec(`cp "archive/${submission.problem}/data.json" "grading/isolate/${data.workerNum}/archive/data.json"`);
        const dataFiles = JSON.parse(await fs.readFile(`grading/isolate/${data.workerNum}/archive/data.json`));
        for (var i = 0; i < grading.subtask.length; i++) if (!datasets.includes(grading.subtask[i].dataset)) datasets.push(grading.subtask[i].dataset);
        var total = 0, sofar = 0;
        var subTotal = [ ], subSofar = [ ];
        var subTime = [ ], subWalltime = [ ], subMem = [ ];
        for (var i = 0; i < grading.subtask.length; i++) {
            subTotal.push(0);
            subSofar.push(0);
            subTime.push(0);
            subWalltime.push(0);
            subMem.push(0);
        }
        for (var i = 0; i < datasets.length; i++) {
            const dataset = datasets[i];
            var k = -1;
            for (var j = 0; j < dataFiles.length; j++) if (dataFiles[j].name === dataset) k = j;
            if (k == -1) return {
                result: 'FL'
            };
            for (var j = 0; j < dataFiles[k].data.length; j++) {
                const name = dataFiles[k].data[j];
                var subtask = [ ];
                for (var l = 0; l < grading.subtask.length; l++) if ((new RegExp (grading.subtask[l].regex)).test(name)) subtask.push(l);
                for (var l = 0; l < grading.subtask.length; l++) for (var e = 0; e < subtask.length; e++) if (grading.subtask[l].hierarchy.includes(subtask[e]) && !subtask.includes(l)) subtask.push(l);
                if (subtask.length > 0) total++;
                for (var l = 0; l < subtask.length; l++) subTotal[subtask[l]]++;
            }
        }
        tmpResult({
            result: 'GD',
            done: 0,
            total: total
        }, submission.filename, submission.type);
        for (var i = 0; i < datasets.length; i++) {
            const dataset = datasets[i];
            var k = -1;
            for (var j = 0; j < dataFiles.length; j++) if (dataFiles[j].name === dataset) k = j;
            if (k == -1) return {
                result: 'FL'
            };
            await exec(`yes | rm -rf grading/isolate/"${data.workerNum}"/archive/data/*`);
            await decompress(`archive/${submission.problem}/data/${dataset}.zip`, `grading/isolate/${data.workerNum}/archive/data`);
            for (var j = 0; j < dataFiles[k].data.length; j++) {
                const name = dataFiles[k].data[j];
                var subtask = [ ]
                for (var l = 0; l < grading.subtask.length; l++) if ((new RegExp (grading.subtask[l].regex)).test(name)) subtask.push(l);
                for (var l = 0; l < grading.subtask.length; l++) for (var e = 0; e < subtask.length; e++) if (grading.subtask[l].hierarchy.includes(subtask[e]) && !subtask.includes(l)) subtask.push(l);
                if (subtask.length <= 0) continue;
                var realCnt = 0;
                for (var l = 0; l < subtask.length; l++) if (!grading.subtask[subtask[l]].finished) realCnt++;
                if (realCnt <= 0) continue;
                try {
                    var tmpTl = 0, tmpWl = 0, tmpMl = 0;
                    for (var l = 0; l < subtask.length; l++) {
                        tmpTl = Math.max(tmpTl, grading.subtask[subtask[l]].tl);
                        tmpWl = Math.max(tmpWl, grading.subtask[subtask[l]].wl);
                        tmpMl = Math.max(tmpMl, grading.subtask[subtask[l]].ml);
                    }
                    const { stdout, stderr } = await isolateExec('/files/run.sh', `--stdin=/files/archive/data/${name}.in --stdout=/files/out --stderr=/files/err`, tmpTl / 1000, tmpWl / 1000, tmpMl, 2, EXEC_LOG);
                } catch (e) { console.log(e); }
                const status = await getLog(EXEC_LOG, 'status');
                const time = parseFloat(await getLog(EXEC_LOG, 'time')) * 1000;
                const walltime = parseFloat(await getLog(EXEC_LOG, 'time-wall')) * 1000;
                const mem = parseFloat(await getLog(EXEC_LOG, 'cg-mem')) * 1024;
                totaltime = Math.max(totaltime, time);
                totalwalltime = Math.max(totalwalltime, walltime);
                totalmem = Math.max(totalmem, mem);
                sofar++;
                for (var l = 0; l < subtask.length; l++) {
                    const num = subtask[l];
                    subTime[num] = Math.max(subTime[num], time);
                    subWalltime[num] = Math.max(subWalltime[num], walltime);
                    subMem[num] = Math.max(subMem[num], mem);
                    if (grading.subtask[num].finished) continue;
                    subSofar[subtask[l]]++;
                    if (time > grading.subtask[num].tl) {
                        r[num] = 'TL';
                        pts[num] = 0;
                        grading.subtask[num].finished = true;
                        tmpResult({
                            result: 'GD',
                            score: getScore(pts, grading, subTotal, subSofar),
                            time: totaltime,
                            walltime: totalwalltime,
                            mem: totalmem,
                            done: sofar,
                            total: total,
                            subResult: r,
                            subPoints: pts,
                            subDone: subSofar,
                            subTotal: subTotal,
                            subTime: subTime,
                            subWalltime: subWalltime,
                            subMem: subMem,
                            max: maxes
                        }, submission.filename, submission.type);
                        continue;
                    }
                    if (walltime > grading.subtask[num].wl) {
                        r[num] = 'WL';
                        pts[num] = 0;
                        grading.subtask[num].finished = true;
                        tmpResult({
                            result: 'GD',
                            score: getScore(pts, grading, subTotal, subSofar),
                            time: totaltime,
                            walltime: totalwalltime,
                            mem: totalmem,
                            done: sofar,
                            total: total,
                            subResult: r,
                            subPoints: pts,
                            subDone: subSofar,
                            subTotal: subTotal,
                            subTime: subTime,
                            subWalltime: subWalltime,
                            subMem: subMem,
                            max: maxes
                        }, submission.filename, submission.type);
                        continue;
                    }
                    if (mem > grading.subtask[num].ml) {
                        r[num] = 'ML';
                        pts[num] = 0;
                        grading.subtask[num].finished = true;
                        tmpResult({
                            result: 'GD',
                            score: getScore(pts, grading, subTotal, subSofar),
                            time: totaltime,
                            walltime: totalwalltime,
                            mem: totalmem,
                            done: sofar,
                            total: total,
                            subResult: r,
                            subPoints: pts,
                            subDone: subSofar,
                            subTotal: subTotal,
                            subTime: subTime,
                            subWalltime: subWalltime,
                            subMem: subMem,
                            max: maxes
                        }, submission.filename, submission.type);
                        continue;
                    }
                    if (status == 'XX') {
                        r[num] = 'FL';
                        pts[num] = 0;
                        grading.subtask[num].finished = true;
                        tmpResult({
                            result: 'GD',
                            score: getScore(pts, grading, subTotal, subSofar),
                            time: totaltime,
                            walltime: totalwalltime,
                            mem: totalmem,
                            done: sofar,
                            total: total,
                            subResult: r,
                            subPoints: pts,
                            subDone: subSofar,
                            subTotal: subTotal,
                            subTime: subTime,
                            subWalltime: subWalltime,
                            subMem: subMem,
                            max: maxes
                        }, submission.filename, submission.type);
                        continue;
                    }
                    if (status == 'RE') {
                        r[num] = 'RE';
                        pts[num] = 0;
                        grading.subtask[num].finished = true;
                        tmpResult({
                            result: 'GD',
                            score: getScore(pts, grading, subTotal, subSofar),
                            time: totaltime,
                            walltime: totalwalltime,
                            mem: totalmem,
                            done: sofar,
                            total: total,
                            subResult: r,
                            subPoints: pts,
                            subDone: subSofar,
                            subTotal: subTotal,
                            subTime: subTime,
                            subWalltime: subWalltime,
                            subMem: subMem,
                            max: maxes
                        }, submission.filename, submission.type);
                        continue;
                    }
                    if (status == 'SG') {
                        r[num] = 'SD';
                        pts[num] = 0;
                        grading.subtask[num].finished = true;
                        tmpResult({
                            result: 'GD',
                            score: getScore(pts, grading, subTotal, subSofar),
                            time: totaltime,
                            walltime: totalwalltime,
                            mem: totalmem,
                            done: sofar,
                            total: total,
                            subResult: r,
                            subPoints: pts,
                            subDone: subSofar,
                            subTotal: subTotal,
                            subTime: subTime,
                            subWalltime: subWalltime,
                            subMem: subMem,
                            max: maxes
                        }, submission.filename, submission.type);
                        continue;
                    }
                    if (status == 'TO') {
                        r[num] = 'TL';
                        pts[num] = 0;
                        grading.subtask[num].finished = true;
                        tmpResult({
                            result: 'GD',
                            score: getScore(pts, grading, subTotal, subSofar),
                            time: totaltime,
                            walltime: totalwalltime,
                            mem: totalmem,
                            done: sofar,
                            total: total,
                            subResult: r,
                            subPoints: pts,
                            subDone: subSofar,
                            subTotal: subTotal,
                            subTime: subTime,
                            subWalltime: subWalltime,
                            subMem: subMem,
                            max: maxes
                        }, submission.filename, submission.type);
                        continue;
                    }
                    if (parseInt(await getLog(EXEC_LOG, 'killed')) == 1) {
                        r[num] = 'SD';
                        pts[num] = 0;
                        grading.subtask[num].finished = true;
                        tmpResult({
                            result: 'GD',
                            score: getScore(pts, grading, subTotal, subSofar),
                            time: totaltime,
                            walltime: totalwalltime,
                            mem: totalmem,
                            done: sofar,
                            total: total,
                            subResult: r,
                            subPoints: pts,
                            subDone: subSofar,
                            subTotal: subTotal,
                            subTime: subTime,
                            subWalltime: subWalltime,
                            subMem: subMem,
                            max: maxes
                        }, submission.filename, submission.type);
                        continue;
                    }
                    try {
                        var res = await isolateExec(`/files/checker${num}`, `/files/archive/data/${name}.out /files/out`, 10, 21, 4 * 1024 * 1024 * 1024, 1000, CHECK_LOG);
                        res.stderr = res.stderr.substr(0, 2);
                        if (res.stderr === 'WA') {
                            r[num] = 'WA';
                            pts[num] = 0;
                            grading.subtask[num].finished = true;
                            tmpResult({
                                result: 'GD',
                                score: getScore(pts, grading, subTotal, subSofar),
                                time: totaltime,
                                walltime: totalwalltime,
                                mem: totalmem,
                                done: sofar,
                                total: total,
                                subResult: r,
                                subPoints: pts,
                                subDone: subSofar,
                                subTotal: subTotal,
                                subTime: subTime,
                                subWalltime: subWalltime,
                                subMem: subMem,
                                max: maxes
                            }, submission.filename, submission.type);
                        } else if (res.stderr === 'PC') {
                            r[num] = 'PC';
                            pts[num] = Math.min(pts[num], parseFloat(res.stdout));
                            tmpResult({
                                result: 'GD',
                                score: getScore(pts, grading, subTotal, subSofar),
                                time: totaltime,
                                walltime: totalwalltime,
                                mem: totalmem,
                                done: sofar,
                                total: total,
                                subResult: r,
                                subPoints: pts,
                                subDone: subSofar,
                                subTotal: subTotal,
                                subTime: subTime,
                                subWalltime: subWalltime,
                                subMem: subMem,
                                max: maxes
                            }, submission.filename, submission.type);
                        } else if (res.stderr !== 'AC') {
                            r[num] = res.stderr;
                            pts[num] = 0;
                            grading.subtask[num].finished = true;
                            tmpResult({
                                result: 'GD',
                                score: getScore(pts, grading, subTotal, subSofar),
                                time: totaltime,
                                walltime: totalwalltime,
                                mem: totalmem,
                                done: sofar,
                                total: total,
                                subResult: r,
                                subPoints: pts,
                                subDone: subSofar,
                                subTotal: subTotal,
                                subTime: subTime,
                                subWalltime: subWalltime,
                                subMem: subMem,
                                max: maxes
                            }, submission.filename, submission.type);
                        }
                    } catch (e) {
                        r[num] = 'CD';
                        pts[num] = 0;
                        grading.subtask[num].finished = true;
                        tmpResult({
                            result: 'GD',
                            score: getScore(pts, grading, subTotal, subSofar),
                            time: totaltime,
                            walltime: totalwalltime,
                            mem: totalmem,
                            done: sofar,
                            total: total,
                            subResult: r,
                            subPoints: pts,
                            subDone: subSofar,
                            subTotal: subTotal,
                            subTime: subTime,
                            subWalltime: subWalltime,
                            subMem: subMem,
                            max: maxes
                        }, submission.filename, submission.type);
                    }
                }
                tmpResult({
                    result: 'GD',
                    score: getScore(pts, grading, subTotal, subSofar),
                    time: totaltime,
                    walltime: totalwalltime,
                    mem: totalmem,
                    done: sofar,
                    total: total,
                    subResult: r,
                    subPoints: pts,
                    subDone: subSofar,
                    subTotal: subTotal,
                    subTime: subTime,
                    subWalltime: subWalltime,
                    subMem: subMem,
                    max: maxes
                }, submission.filename, submission.type);
            }
        }
    } catch (e) {
        console.log(e);
        return {
            result: 'FL'
        };
    }
    var totalScore = getScore(pts, grading, subTotal, subSofar), totalResult = 'AC', worstResult = 'AC';
    for (var i = 0; i < grading.subtask.length; i++) {
        if (pts[i] < 1) totalResult = 'PC';
        if (pts[i] <= 0) {
            if (r[i] === 'AC') continue;
            else if (r[i] === 'TL') worstResult = 'TL';
            else if (r[i] === 'WL') worstResult = 'WL';
            else if (r[i] === 'SD') worstResult = 'SD';
            else if (r[i] === 'RE') worstResult = 'RE';
            else if (r[i] === 'ML') worstResult = 'ML';
            else worstResult = r[i];
        }
    }
    if (totalScore <= 0) totalResult = worstResult;
    return {
        result: totalResult,
        score: totalScore,
        time: totaltime,
        walltime: totalwalltime,
        mem: totalmem,
        done: sofar,
        total: total,
        subResult: r,
        subPoints: pts,
        subDone: subSofar,
        subTotal: subTotal,
        subTime: subTime,
        subWalltime: subWalltime,
        subMem: subMem,
        max: maxes
    };
}

async function compile(submission) {
    const COMPILE_CHECKER_LOG = `grading/isolate/${data.workerNum}/compile_checker.log`;
    var r = 'AC';
    try {
        await exec(`yes | rm -rf grading/isolate/"${data.workerNum}"/*`);
        await exec(`cp "grading/testlib.h" "grading/isolate/${data.workerNum}/testlib.h"`);
        await exec(`cp "grading/checker.sh" "grading/isolate/${data.workerNum}/compile.sh"`);
        await exec(`cp "grading/checkers/${submission.filename}.cpp" "grading/isolate/${data.workerNum}/checker.cpp"`);
        try {
            await isolateExec('/files/compile.sh', '/files/checker /files/checker.cpp --stderr=/files/compile.out', 10, 21, 512 * 1024 * 1024, 1000, COMPILE_CHECKER_LOG);
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

async function grading(submission) {
    const COMPILE_CHECKER_LOG = `grading/isolate/${data.workerNum}/compile_checker.log`;
    const EXEC_LOG = `grading/isolate/${data.workerNum}/exec.log`;
    var r = 'AC';
    try {
        for (var idx = 0; idx < submission.files.checkers.length; idx++) {
            const checker = submission.files.checkers[idx];
            await exec(`yes | rm -rf grading/isolate/"${data.workerNum}"/*`);
            await exec(`cp "grading/testlib.h" "grading/isolate/${data.workerNum}/testlib.h"`);
            await exec(`cp "grading/checker.sh" "grading/isolate/${data.workerNum}/compile.sh"`);
            await exec(`cp "${checker}" "grading/isolate/${data.workerNum}/checker.cpp"`);
            try {
                await isolateExec('/files/compile.sh', '/files/checker /files/checker.cpp --stderr=/files/compile.out', 10, 21, 512 * 1024 * 1024, 1000, COMPILE_CHECKER_LOG);
            } catch (e) {
                return {
                    result: 'FL',
                    log: (await fs.readFile(`grading/isolate/${data.workerNum}/compile.out`)).toString(),
                    subtask: idx + 1,
                    type: 'checker'
                };
            }
            tmpResult({
                result: 'CA',
                subtask: idx + 1
            }, submission.id, submission.type);
        }
        for (var idx = 0; idx < submission.files.validators.length; idx++) {
            const { validator, dataset, subtask } = submission.files.validators[idx];
            var hierarchies = submission.files.validators[idx].hierarchies.slice();
            const datafiles = submission.files.validators[idx].data;
            await exec(`yes | rm -rf grading/isolate/"${data.workerNum}"/*`);
            await exec(`cp "grading/testlib.h" "grading/isolate/${data.workerNum}/testlib.h"`);
            await exec(`cp "grading/checker.sh" "grading/isolate/${data.workerNum}/compile.sh"`);
            await exec(`cp "${validator}" "grading/isolate/${data.workerNum}/validator.cpp"`);
            try {
                await isolateExec('/files/compile.sh', '/files/validator /files/validator.cpp --stderr=/files/compile.out', 10, 21, 512 * 1024 * 1024, 1000, COMPILE_CHECKER_LOG);
            } catch (e) {
                return {
                    result: 'FL',
                    log: (await fs.readFile(`grading/isolate/${data.workerNum}/compile.out`)).toString(),
                    subtask: subtask,
                    type: 'validator'
                };
            }
            tmpResult({
                result: 'VA',
                subtask: subtask
            }, submission.id, submission.type);
            hierarchies.push(subtask);
            submission.files.validators[idx].size = datafiles.length;
            var cnt = 0, total = 0;
            for (var g = 0; g < hierarchies.length; g++) {
                var curr = -1;
                for (var e = 0; e < submission.files.validators.length; e++) if (submission.files.validators[e].subtask == hierarchies[g]) curr = e;
                if (curr == -1) return {
                    result: 'FL',
                    log: 'Invalid hierarchies',
                    subtask: subtask
                }
                total += submission.files.validators[curr].size;
            }
            for (var g = 0; g < hierarchies.length; g++) {
                var curr = -1;
                for (var e = 0; e < submission.files.validators.length; e++) if (submission.files.validators[e].subtask == hierarchies[g]) curr = e;
                if (curr == -1) return {
                    result: 'FL',
                    log: 'Invalid hierarchies',
                    subtask: subtask
                }
                await exec(`yes | rm -rf grading/isolate/"${data.workerNum}"/archive/data/*`);
                await decompress(`archive/${submission.problem}/data/${submission.files.validators[curr].dataset}.zip`, `grading/isolate/${data.workerNum}/archive/data`);
                await exec(`cp "archive/${submission.problem}/data.json" "grading/isolate/${data.workerNum}/data.json"`);
                const dataJson = JSON.parse(await fs.readFile(`grading/isolate/${data.workerNum}/data.json`));
                var k = -1;
                for (var i = 0; i < dataJson.length; i++) if (dataJson[i].name === submission.files.validators[curr].dataset) k = i;
                if (k == -1) return {
                    result: 'FL',
                    log: 'No data',
                    subtask: subtask,
                    type: 'validator'
                };

                for (var i = 0; i < submission.files.validators[curr].data.length; i++) {
                    try {
                        await isolateExec('/files/validator', `--stdin=/files/archive/data/${submission.files.validators[curr].data[i]}.in --stdout=/files/out --stderr=/files/err`, 10, 21, 512 * 1024 * 1024, 1000, EXEC_LOG);
                    } catch (e) {
                        return {
                            result: 'FL',
                            log: (await fs.readFile(`grading/isolate/${data.workerNum}/err`)).toString(),
                            dataset: submission.files.validators[curr].dataset,
                            data: submission.files.validators[curr].data[i],
                            subtask: subtask,
                            type: 'validator'
                        };
                    }
                    tmpResult({
                        result: 'DA',
                        progress: (cnt + 1) / total,
                        subtask: subtask
                    }, submission.id, submission.type);
                    cnt++;
                }
            }
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
    return {
        result: 'AC'
    };
}