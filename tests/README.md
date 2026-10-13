# Tests

The transfer-function conversion test suite exercises the conversion code embedded in the single-file `index.html` page. It covers ZOH, inverse bilinear (Tustin), and matched pole-zero conversion for first- and second-order models with real and complex poles, plus exact sampled-data and invalid-root cases.

The identification cases generate deterministic CSV input/output data for a triangular ramp, sine wave, and chirp, then call the same CSV parser and least-squares routines used by the page. They also assert the correct error for missing CSV columns/values, invalid numbers, non-increasing times, too few samples, zero excitation, and rank-deficient regressors.

Requirements: Node.js 22 or newer. Run locally from the repository root:

```sh
node --test tests/conversions.test.cjs tests/model-identification.test.cjs
```

The same command runs on pushes to `main` and on GitHub pull requests targeting `main`. CI uses a self-hosted Windows x64 GitHub Actions runner and sets up Node.js 22 in the workflow.

Register the runner from **Repository Settings → Actions → Runners → New self-hosted runner** and follow GitHub's Windows setup commands. Keep the runner online for checks to run. Self-hosted runners execute pull-request code on this PC; only use this configuration if you trust contributors, and consider an isolated disposable VM for public repositories.

## AdSense activation

The page has top and bottom responsive ad placements. They stay hidden and do not load Google's ad script while the publisher ID and slot IDs in the AdSense configuration near the end of `index.html` are blank. To activate them, apply for AdSense, add and get the site approved in the AdSense account, then fill in the account's `ca-pub-...` publisher ID and the numeric ad-slot IDs for the placements you want to use. Publisher and slot IDs are public identifiers, not secrets.

Before serving ads, publish the required privacy disclosures and consent flow for the regions you serve, and make sure `https://<your-site>/ads.txt` returns the seller declaration supplied by AdSense. This repository currently deploys a single HTML page and does not configure a Worker route for `ads.txt`; add that route to the Cloudflare Worker deployment before requesting ads.txt authorization. Do not publish a guessed or placeholder seller ID.
