"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const conversionMethods = ["zoh", "bilinear", "matched"];
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const conversionScript = html.match(/<script id="system-id-conversions">([\s\S]*?)<\/script>/);
assert.ok(conversionScript, "inline converter should remain available for single-file Cloudflare hosting");
const browserContext = { window: {} };
vm.runInNewContext(conversionScript[1], browserContext);
const { convert, evaluateContinuous } = browserContext.window.SystemIdConversions;

function fit(a, b, dt = 0.1) {
    return {
        a,
        b,
        dt,
        dcGain: b.reduce((sum, value) => sum + value, 0)
            / (1 - a.reduce((sum, value) => sum + value, 0))
    };
}

function close(actual, expected, tolerance = 1e-8) {
    assert.ok(
        Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)),
        `expected ${actual} to be within ${tolerance} of ${expected}`
    );
}

function evalDiscrete(model, z) {
    let numerator = 0;
    for (const coefficient of model.b) numerator = numerator * z + coefficient;
    let denominator = 1;
    for (const coefficient of model.a) denominator = denominator * z - coefficient;
    return numerator / denominator;
}

const fixtures = [
    {
        name: "first order with a real pole",
        model: fit([0.8], [0.2]),
        expectedOrder: 1
    },
    {
        name: "second order with distinct real poles",
        model: fit([1.2, -0.32], [0.1, -0.04]),
        expectedOrder: 2
    },
    {
        name: "second order with a complex-conjugate pole pair",
        model: fit([1.2, -0.64], [0.1, -0.04]),
        expectedOrder: 2
    }
];

for (const fixture of fixtures) {
    for (const method of conversionMethods) {
        test(`${method} converts ${fixture.name}`, () => {
            const converted = convert(fixture.model, method);
            assert.equal(converted.method, method);
            assert.equal(converted.denominator.length, fixture.expectedOrder + 1);
            assert.ok(converted.numerator.length <= converted.denominator.length);
            assert.ok(converted.numerator.every(Number.isFinite));
            assert.ok(converted.denominator.every(Number.isFinite));
            close(converted.denominator[0], 1);
            close(evaluateContinuous(converted, 0).re, fixture.model.dcGain);
            close(evaluateContinuous(converted, 0).im, 0);
        });
    }
}

test("ZOH conversion preserves the fitted discrete poles and residues", () => {
    const model = fit([1.2, -0.64], [0.1, 0.2], 0.05);
    const converted = convert(model, "zoh");
    assert.equal(converted.discretePoles.length, 2);

    for (let i = 0; i < converted.discretePoles.length; i++) {
        const z = converted.discretePoles[i];
        const s = converted.poles[i];
        const expReal = Math.exp(s.re * model.dt);
        const expImaginary = s.im * model.dt;
        close(expReal * Math.cos(expImaginary), z.re);
        close(expReal * Math.sin(expImaginary), z.im);

        const difference = { re: z.re - 1, im: z.im };
        const product = {
            re: converted.continuousResidues[i].re * difference.re
                - converted.continuousResidues[i].im * difference.im,
            im: converted.continuousResidues[i].re * difference.im
                + converted.continuousResidues[i].im * difference.re
        };
        const sTimesResidue = {
            re: s.re * converted.discreteResidues[i].re - s.im * converted.discreteResidues[i].im,
            im: s.re * converted.discreteResidues[i].im + s.im * converted.discreteResidues[i].re
        };
        close(product.re, sTimesResidue.re);
        close(product.im, sTimesResidue.im);
    }
});

test("ZOH conversion reproduces unit-step output at every sample instant", () => {
    const model = fit([1.2, -0.64], [0.1, 0.2], 0.05);
    const converted = convert(model, "zoh");
    const samples = 24;
    const discreteOutput = Array(samples).fill(0);

    for (let k = 1; k < samples; k++) {
        for (let lag = 1; lag <= model.a.length; lag++) {
            if (k - lag >= 0) discreteOutput[k] += model.a[lag - 1] * discreteOutput[k - lag];
            if (k - lag >= 0) discreteOutput[k] += model.b[lag - 1];
        }

        let continuousOutput = { re: model.dcGain, im: 0 };
        for (let i = 0; i < converted.poles.length; i++) {
            const pole = converted.poles[i];
            const residue = converted.continuousResidues[i];
            const scaledResidue = {
                re: (residue.re * pole.re + residue.im * pole.im) / (pole.re ** 2 + pole.im ** 2),
                im: (residue.im * pole.re - residue.re * pole.im) / (pole.re ** 2 + pole.im ** 2)
            };
            const exponentialMagnitude = Math.exp(pole.re * k * model.dt);
            const exponential = {
                re: exponentialMagnitude * Math.cos(pole.im * k * model.dt),
                im: exponentialMagnitude * Math.sin(pole.im * k * model.dt)
            };
            continuousOutput = {
                re: continuousOutput.re + scaledResidue.re * exponential.re - scaledResidue.im * exponential.im,
                im: continuousOutput.im + scaledResidue.re * exponential.im + scaledResidue.im * exponential.re
            };
        }
        close(continuousOutput.im, 0, 1e-7);
        close(continuousOutput.re, discreteOutput[k], 1e-7);
    }
});

test("ZOH conversion reproduces the original discrete transfer function at sample frequencies", () => {
    const model = fit([1.2, -0.64], [0.1, 0.2], 0.05);
    const converted = convert(model, "zoh");

    for (const angle of [0.1, 0.7, 1.3, 2.4]) {
        const z = { re: Math.cos(angle), im: Math.sin(angle) };
        let reconstructed = { re: 0, im: 0 };
        for (let i = 0; i < converted.discretePoles.length; i++) {
            const pole = converted.discretePoles[i];
            const residue = converted.discreteResidues[i];
            const delta = { re: z.re - pole.re, im: z.im - pole.im };
            const denominator = delta.re ** 2 + delta.im ** 2;
            const quotient = {
                re: (residue.re * delta.re + residue.im * delta.im) / denominator,
                im: (residue.im * delta.re - residue.re * delta.im) / denominator
            };
            reconstructed = {
                re: reconstructed.re + quotient.re,
                im: reconstructed.im + quotient.im
            };
        }

        let discreteNumerator = { re: 0, im: 0 };
        for (const coefficient of model.b) {
            discreteNumerator = {
                re: discreteNumerator.re * z.re - discreteNumerator.im * z.im + coefficient,
                im: discreteNumerator.re * z.im + discreteNumerator.im * z.re
            };
        }
        let discreteDenominator = { re: 1, im: 0 };
        for (const coefficient of model.a) {
            discreteDenominator = {
                re: discreteDenominator.re * z.re - discreteDenominator.im * z.im - coefficient,
                im: discreteDenominator.re * z.im + discreteDenominator.im * z.re
            };
        }
        const expected = {
            re: (discreteNumerator.re * discreteDenominator.re + discreteNumerator.im * discreteDenominator.im)
                / (discreteDenominator.re ** 2 + discreteDenominator.im ** 2),
            im: (discreteNumerator.im * discreteDenominator.re - discreteNumerator.re * discreteDenominator.im)
                / (discreteDenominator.re ** 2 + discreteDenominator.im ** 2)
        };
        close(reconstructed.re, expected.re, 1e-7);
        close(reconstructed.im, expected.im, 1e-7);
    }
});

test("bilinear conversion maps the discrete Nyquist response to continuous high-frequency gain", () => {
    const model = fit([0.8], [0.2]);
    const converted = convert(model, "bilinear");
    const highFrequency = evaluateContinuous(converted, 1e9);
    close(highFrequency.re, evalDiscrete(model, -1), 1e-7);
    close(highFrequency.im, 0, 1e-7);
});

test("matched pole-zero conversion maps finite zeros with the principal logarithm", () => {
    const model = fit([0.8, -0.15], [0.2, -0.1]);
    const converted = convert(model, "matched");
    assert.equal(converted.zeros.length, 1);
    const discreteZero = 0.5;
    close(converted.zeros[0].re, Math.log(Math.abs(discreteZero)) / model.dt);
    close(converted.zeros[0].im, 0);
});

test("unknown conversion methods fail explicitly", () => {
    assert.throws(() => convert(fit([0.8], [0.2]), "unknown"), /Unknown continuous conversion method/);
});

test("matched pole-zero conversion rejects a lone negative real zero rather than returning a complex model", () => {
    assert.throws(
        () => convert(fit([0.8, -0.15], [0.1, 0.2]), "matched"),
        /complex coefficients/
    );
});

test("ZOH conversion reports repeated poles as unsupported", () => {
    assert.throws(
        () => convert(fit([0.8, -0.16], [0.1, 0.02]), "zoh"),
        /Repeated or near-repeated/
    );
});
