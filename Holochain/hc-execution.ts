import child_process from "child_process";
import fs from "fs";

//This may be needed as bootstrap url on sandboxes to help them find eachother
const bootStrapUrl = "https://bootstrap-staging.holo.host"
const kitsuneProxy = "kitsune-proxy://SYVd4CF3BdJ4DS7KwLLgeU3_DbHoZ34Y-qroZ79DOs8/kitsune-quic/h/165.22.32.11/p/5779/--"

function escapeShellArg (arg) {
    return arg.replace(" ", "\ ");
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export async function createSandbox(hcPath, sbPath) {
    let res = await child_process.execFile(`${escapeShellArg(hcPath)}`, ["sandbox", "create", "--root", sbPath, "network", "--bootstrap", `${bootStrapUrl}`, "quic", "-p", `${kitsuneProxy}`], (error, stdout, stderr) => {
        if (error) {
            console.error('stderr', stderr);
            throw error;
        }
        console.log('stdout', stdout);
    }).toString();
    console.log("Got res creating sandbox", res);
    return res
}

export function readSandboxes(hcPath) {
    let sb = child_process.execSync(`${escapeShellArg(hcPath)} sandbox list`).toString();
    let lines = sb.split(/\r\n|\r|\n/);
    if (lines.length == 4) {
        return []
    } else {
        let linesOut = [];
        lines.slice(2, -2).forEach(val => {
            linesOut.push(escapeShellArg(val.substring(3)));
        });
        return linesOut;
    }
}

export function stopProcesses(sbPath, hcProcess, lairProcess) {
    fs.unlinkSync(`${escapeShellArg(sbPath)}/keystore/pid`)
    hcProcess.kill("SIGINT");
    lairProcess.kill("SIGINT");
}

export function unpackDna(hcPath, dnaPath) {
    return child_process.execFileSync(`${escapeShellArg(hcPath)}`, ["dna", "unpack", `${escapeShellArg(dnaPath)}`]).toString();
}

export function packDna(hcPath, workdirPath) {
    return child_process.execFileSync(`${escapeShellArg(hcPath)}`, ["dna", "pack", `${escapeShellArg(workdirPath)}`]).toString();
}

export async function runSandbox(lairPath, hcPath, holochainPath, sbPath, adminPort) {
    let lairProcess = child_process.spawn(`${escapeShellArg(lairPath)}`, [], {
        stdio: "inherit",
        env: { ...process.env, LAIR_DIR: `${escapeShellArg(sbPath)}/keystore` },
    });
    await sleep(500);
    
    let hcProcess = child_process.spawn(`${escapeShellArg(hcPath)}`, ["sandbox", "-f", adminPort, "--holochain-path", `${escapeShellArg(holochainPath)}`, "run", "-e", escapeShellArg(sbPath)],
        {
            stdio: "inherit",
            env: {
                ...process.env,
                RUST_LOG: process.env.RUST_LOG ? process.env.RUST_LOG : "info",
            },
        }
    );
    process.on("SIGINT", function () {
        fs.unlinkSync(`${escapeShellArg(sbPath)}/keystore/pid`)
        hcProcess.kill("SIGINT");
        lairProcess.kill("SIGINT");
        process.exit();
    });

    await sleep(5000);
    return [hcProcess, lairProcess];
}

export function cleanSandboxes(hcPath) {
    return child_process.execSync(`${escapeShellArg(hcPath)} sandbox clean`).toString();
}