const obfuscator = require('javascript-obfuscator');
const fs = require('fs');

console.log('Reading app.js...');
const code = fs.readFileSync('app.js', 'utf8');

console.log('Obfuscating code (this protects against reverse engineering)...');
const obfuscationResult = obfuscator.obfuscate(code, {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.75,
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.4,
    debugProtection: false,
    disableConsoleOutput: false,
    identifierNamesGenerator: 'hexadecimal',
    log: false,
    numbersToExpressions: true,
    renameGlobals: false,
    selfDefending: true,
    simplify: true,
    splitStrings: true,
    splitStringsChunkLength: 10,
    stringArray: true,
    stringArrayCallsTransform: true,
    stringArrayCallsTransformThreshold: 0.5,
    stringArrayEncoding: ['base64'],
    stringArrayIndexShift: true,
    stringArrayRotate: true,
    stringArrayShuffle: true,
    stringArrayWrappersCount: 1,
    stringArrayWrappersChainedCalls: true,
    stringArrayWrappersParametersMaxCount: 2,
    stringArrayWrappersType: 'variable',
    stringArrayThreshold: 0.75,
    unicodeEscapeSequence: false
});

fs.writeFileSync('app.obfuscated.js', obfuscationResult.getObfuscatedCode());
console.log('Success! Obfuscated code written to app.obfuscated.js');

// Now, update index.html to use the obfuscated version for production if needed.
// For now, we just generate the file.
