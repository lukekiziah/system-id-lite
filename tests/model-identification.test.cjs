"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const mainScript = html.match(/<script>\s*([\s\S]*?)<\/script>/);
assert.ok(mainScript, "main application script should be present");

const modelStart = mainScript[1].indexOf("function parseCSV(text)");
const modelEnd = mainScript[1].indexOf("function complex(re, im = 0)");
assert.ok(modelStart >= 0 && modelEnd > modelStart, "CSV parser and fit routine should remain testable");

const context = {};
vm.runInNewContext(mainScript[1].slice(modelStart, modelEnd), context);

test("built-in broadband sample data fits every supported model order", () => {
    const data = context.createSampleData();
    assert.equal(data.time.length, 512);
    assert.ok(data.input.some(value => value < 0) && data.input.some(value => value > 0));

    for (let order = 1; order <= 6; order++) {
        const model = context.identifyModel(data, order);
        assert.equal(model.order, order);
        assert.ok(Number.isFinite(model.r2), `order ${order} should have a finite R²`);
        assert.ok(model.confidenceIntervals.every(interval =>
            interval && interval.every(Number.isFinite)), `order ${order} should have finite confidence intervals`);
    }

    const fullOrderFit = context.identifyModel(data, 6);
    assert.ok(fullOrderFit.r2 > 1 - 1e-10, `sixth-order sample fit R²=${fullOrderFit.r2}`);
    assert.ok(fullOrderFit.sse < 1e-16, `sixth-order sample fit SSE=${fullOrderFit.sse}`);
});

const timeStep = 0.1;
const trueA = [1.15, -0.28];
const trueB = [0.12, 0.04];

function generateCase(name, input) {
    const output = Array(input.length).fill(0);
    for (let k = 2; k < input.length; k++) {
        output[k] = trueA[0] * output[k - 1]
            + trueA[1] * output[k - 2]
            + trueB[0] * input[k - 1]
            + trueB[1] * input[k - 2];
    }
    const csv = [
        "time,input,output",
        ...input.map((value, index) =>
            `${(index * timeStep).toFixed(1)},${value.toPrecision(12)},${output[index].toPrecision(12)}`)
    ].join("\n");
    return { name, csv };
}

const sampleCount = 240;
const rampInput = Array.from({ length: sampleCount }, (_, index) => {
    const phase = (index % 80) / 40;
    return phase <= 1 ? phase : 2 - phase;
});
const sineInput = Array.from({ length: sampleCount }, (_, index) =>
    Math.sin(2 * Math.PI * 0.037 * index)
);
const chirpInput = Array.from({ length: sampleCount }, (_, index) => {
    const normalizedTime = index / (sampleCount - 1);
    const phase = 2 * Math.PI * (0.018 * index + 0.5 * (0.18 - 0.018) * index * normalizedTime);
    return Math.sin(phase);
});

const excitationCases = [
    generateCase("ramp", rampInput),
    generateCase("sine", sineInput),
    generateCase("chirp", chirpInput)
];

for (const excitationCase of excitationCases) {
    test(`order-2 fit identifies the known model for ${excitationCase.name} input`, () => {
        const data = context.parseCSV(excitationCase.csv);
        assert.equal(data.time.length, sampleCount);

        const model = context.identifyModel(data, 2);
        assert.ok(Math.abs(model.a[0] - trueA[0]) < 1e-7, `a1=${model.a[0]}`);
        assert.ok(Math.abs(model.a[1] - trueA[1]) < 1e-7, `a2=${model.a[1]}`);
        assert.ok(Math.abs(model.b[0] - trueB[0]) < 1e-7, `b1=${model.b[0]}`);
        assert.ok(Math.abs(model.b[1] - trueB[1]) < 1e-7, `b2=${model.b[1]}`);
        assert.ok(model.sse < 1e-16, `SSE=${model.sse}`);
        assert.ok(model.r2 > 1 - 1e-10, `R²=${model.r2}`);
        assert.equal(model.confidenceIntervals.length, 4);
        [...trueA, ...trueB].forEach((coefficient, index) => {
            const interval = model.confidenceIntervals[index];
            assert.ok(interval[0] <= coefficient && coefficient <= interval[1],
                `90% CI for coefficient ${index + 1} does not contain ${coefficient}`);
        });
        assert.ok(model.confidenceIntervals.every(interval =>
            interval && interval[0] <= interval[1] && interval.every(Number.isFinite)));
    });
}

test("CSV parser rejects missing required columns with a clear message", () => {
    assert.throws(
        () => context.parseCSV("time,output\n0,0\n1,1\n2,2"),
        /CSV headers must include time, input, and output/
    );
});

test("CSV parser rejects missing and non-numeric input/output values with a clear line number", () => {
    assert.throws(
        () => context.parseCSV("time,input,output\n0,0,0\n1,,1\n2,1,2"),
        /Missing numeric data on line 3/
    );
    assert.throws(
        () => context.parseCSV("time,input,output\n0,0,0\n1,not-a-number,1\n2,1,2"),
        /Invalid numeric data on line 3/
    );
});

test("CSV parser rejects non-increasing timestamps", () => {
    assert.throws(
        () => context.parseCSV("time,input,output\n0,0,0\n1,1,1\n1,2,2"),
        /Time must be strictly increasing/
    );
});

test("CSV parser rejects fewer than three valid samples", () => {
    assert.throws(
        () => context.parseCSV("time,input,output\n0,0,0\n1,1,1"),
        /At least three valid data points are required/
    );
});

test("model fit rejects insufficient observations for the selected order", () => {
    const data = context.parseCSV(
        "time,input,output\n0,0,0\n1,1,0\n2,0,0\n3,1,0\n4,0,0"
    );
    assert.throws(
        () => context.identifyModel(data, 2),
        /Order 2 needs at least 6 samples; this file has 5/
    );
});

test("model fit rejects zero-excitation data rather than returning arbitrary coefficients", () => {
    const data = context.parseCSV(
        "time,input,output\n0,0,0\n1,0,0\n2,0,0\n3,0,0\n4,0,0\n5,0,0"
    );
    assert.throws(
        () => context.identifyModel(data, 1),
        /do not sufficiently excite every model coefficient/
    );
});

test("model fit reports collinear regressors as rank-deficient", () => {
    const data = context.parseCSV(
        "time,input,output\n0,0,0\n1,1,1\n2,2,2\n3,3,3\n4,4,4\n5,5,5"
    );
    assert.throws(
        () => context.identifyModel(data, 1),
        /regression is rank-deficient/
    );
});

test("model fit does not report confidence intervals without residual degrees of freedom", () => {
    const data = {
        time: [0, 1, 2, 3, 4, 5],
        input: [1, 0, 0, 1, 0, 0],
        output: [0.2, -0.3, 0.7, 1.4, -0.8, 0.6]
    };
    const model = context.identifyModel(data, 2);
    assert.equal(model.residualDegreesOfFreedom, 0);
    assert.ok(model.confidenceIntervals.every(interval => interval === null));
});
