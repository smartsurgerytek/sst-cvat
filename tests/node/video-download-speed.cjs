// SPDX-License-Identifier: MIT
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const ts = require('typescript');
const source = fs.readFileSync(require('node:path').join(__dirname, '../../cvat-core/src/video-download-speed.ts'), 'utf8');
function fixture() {
    let time = 0;
    const api = {};
    new Function('exports', 'performance', ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText)(api, { now: () => time });
    return { ...api, at: (value) => { time = value; } };
}
test('reports actual bytes including response wait and stops when idle', () => {
    const m = fixture();
    const t = m.startVideoDownload('job:4');
    m.at(1000); t.progress(2000000);
    assert.deepEqual(m.videoDownloadSpeed('job:4'), { active: true, mbps: 16 });
    m.at(3500);
    assert.equal(m.videoDownloadSpeed('job:4').mbps, 0);
    t.finish();
    assert.deepEqual(m.videoDownloadSpeed('job:4'), { active: false, mbps: null });
});
test('parallel downloads aggregate bytes, duplicate progress does not inflate rate, jobs isolated', () => {
    const m = fixture();
    const a = m.startVideoDownload('job:4');
    const b = m.startVideoDownload('job:4');
    m.startVideoDownload('job:5');
    m.at(1000); a.progress(1000000); a.progress(1000000); b.progress(1000000);
    assert.equal(m.videoDownloadSpeed('job:4').mbps, 16);
    assert.equal(m.videoDownloadSpeed('job:5').mbps, 0);
    a.finish(); assert.equal(m.videoDownloadSpeed('job:4').active, true);
    b.finish();
    const c = m.startVideoDownload('job:4');
    m.at(2000); c.progress(500000);
    assert.equal(m.videoDownloadSpeed('job:4').mbps, 4);
});
