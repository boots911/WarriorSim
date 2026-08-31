importScripts(
    './data/buffs.min.js',
    './data/enchants.min.js',
    './data/levelstats.min.js',
    './data/spells.min.js',
    './data/talents.min.js',
    './classes/player.min.js',
    './classes/simulation.min.js',
    './classes/spell.min.js',
    './classes/weapon.min.js',
    './globals.min.js',
    './data/gear.min.js',
);

onmessage = (event) => {
    const params = event.data;
    if (params.globals) updateGlobals(params.globals);

    // Batch mode: sim a list of full gear combinations at low iteration counts
    if (params.batch) {
        const results = [];
        let lastprogress = 0;
        for (let i = 0; i < params.batch.length; i++) {
            const combo = params.batch[i];
            applyGearMap(combo.gearmap);
            const config = Object.assign({}, params.playerConfig, { autoitemspells: true, logging: false });
            const player = new Player(undefined, undefined, undefined, config);
            if (!player.mh) {
                results.push({ error: 'noweapon' });
                continue;
            }
            let report = null;
            const sim = new Simulation(player, (r) => { report = r; }, null,
                Object.assign({}, params.sim, { iterations: combo.iterations }));
            sim.startSync();
            const n = report.iterations;
            const mean = report.sumdps / n;
            const varmean = n > 1 ? (report.sumdps2 - report.sumdps * report.sumdps / n) / (n - 1) / n : 0;
            results.push({ mean, varmean, n });
            const now = Date.now();
            if (now - lastprogress > 200) {
                lastprogress = now;
                postMessage([TYPE.UPDATE, i + 1, params.batch.length]);
            }
        }
        postMessage([TYPE.FINISHED, results]);
        return;
    }

    const player = new Player(...params.player);
    const sim = new Simulation(player, (report) => {
        // Finished
        if (params.fullReport) {
            report.player = player.serializeStats();
            report.spread = sim.spread;
        }
        postMessage([TYPE.FINISHED, report]);
    }, (iteration, report) => {
        // Update
        postMessage([TYPE.UPDATE, iteration, report]);
    }, params.sim);
    sim.startSync();
};
