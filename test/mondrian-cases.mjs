// Deterministic inputs shared by the regression corpus and its captured results.
export function* mondrianCases() {
    yield ['empty', []];
    for (let size = 1; size <= 25; size++) for (let n = 1; n <= 150; n++) yield ['uniform', Array(n).fill(size)];
    let seed = 123456789;
    const random = n => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % n; };
    for (let i = 0; i < 1000; i++) yield ['squares', Array.from({ length: 1 + random(600) }, () => 1 + random([9, 10, 15][i % 3]))];
    for (const largest of [9, 10, 11]) {
        yield ['holes', Array.from({ length: 3000 }, (_, i) => i % 17 === 0 ? largest : 1 + (i * 13 % largest))];
        yield ['holes', Array.from({ length: 3000 }, (_, i) => i < 40 || i % 11 === 0 ? largest : 1)];
    }
    for (const n of [10, 100, 1000, 10000]) {
        yield ['growth', Array.from({ length: n }, (_, i) => i % 13 === 0 ? 15 : 1)];
        yield ['growth', Array.from({ length: n }, (_, i) => 1 + i * 7 % 41)];
    }
    for (const [w, h] of [[1, 1], [2, 9], [9, 2], [13, 11], [1, 150]])
        for (const n of [1, 2, 3, 20, 127]) yield ['rect-uniform', Array.from({ length: n }, () => [w, h])];
    yield ['rect-wide', [[100, 3], [1, 90], [60, 2]]];
    yield ['rect-wide', [[70000, 1], [1, 2], [70001, 1]]];
    seed = 123456789;
    for (let i = 0; i < 1000; i++) yield ['rectangles', Array.from({ length: 1 + random(150) }, () => [1 + random(50), 1 + random(50)])];
    for (const n of [40, 300, 2016]) yield ['rect-growth', Array.from({ length: n }, (_, i) => i % 3 === 0 ? [1, 91] : i % 3 === 1 ? [83, 1] : [1 + i % 29, 1 + i % 37])];
}
