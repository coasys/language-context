import {cleanSandboxes, createSandbox, readSandboxes, runSandbox} from "../Holochain/hc-execution";

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

describe('Language Context', () => {
    it('Can create & get sandboxes', async () => {
        let gen = createSandbox("./bin/hc", "./chains");
        let res = readSandboxes("./bin/hc");
        expect(res).toHaveLength(1);

        let start = await runSandbox("./bin/lair-keystore", "./bin/hc", "./bin/holochain", res[0], 1000);
        console.log("Started with", start);

        sleep(1000);
        cleanSandboxes("./bin/hc");
    })
})