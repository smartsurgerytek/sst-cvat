// SPDX-License-Identifier: MIT
module.exports = function transpile(source) {
    return require('typescript').transpileModule(source, {
        compilerOptions: { jsx: 4, module: 1, target: 7, esModuleInterop: true },
    }).outputText;
};
