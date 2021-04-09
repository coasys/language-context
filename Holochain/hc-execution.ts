import child_process from "child_process";
import fs from "fs";

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function createSandbox(hcPath, sbPath) {
    return child_process.execSync(`${hcPath} sandbox create --root ${sbPath} network quic`).toString();
}

export function readSandboxes(hcPath) {
    let sb = child_process.execSync(`${hcPath} sandbox list`).toString();
    let lines = sb.split(/\r\n|\r|\n/);
    if (lines.length == 4) {
        return []
    } else {
        let linesOut = [];
        lines.slice(2, -2).forEach(val => {
            linesOut.push(val.substring(3));
        });
        return linesOut;
    }
}

export async function runSandbox(hcPath, holochainPath, sbPath, adminPort) {
    child_process.spawn("lair-keystore", [], {
        stdio: "inherit",
        env: { ...process.env, LAIR_DIR: `${sbPath}/keystore` },
    });
    await sleep(500);
    
    let res = child_process.spawn(`${hcPath}`, ["sandbox", "-f", adminPort, "--holochain-path", `${holochainPath}`, "run", "-e", sbPath],
        {
            stdio: "inherit",
            env: {
                ...process.env,
                RUST_LOG: process.env.RUST_LOG ? process.env.RUST_LOG : "info",
            },
        }
    );
    process.on("SIGINT", function () {
        fs.unlinkSync(`${sbPath}/keystore/pid`)
        res.kill("SIGINT");
        process.exit();
    });

    await sleep(3000);
    return res;
}

export function cleanSandboxes(hcPath) {
    return child_process.execSync(`${hcPath} sandbox clean`).toString();
}