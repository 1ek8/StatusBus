import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

function isPrivateIPv4(addr: string): boolean {
    const parts = addr.split(".").map(Number);
    if (parts.length !== 4) return true;
    const [a, b] = parts;
    return (
        a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 0) ||
        (a === 192 && b === 168) ||
        (a === 198 && (b === 18 || b === 19)) ||
        a >= 240
    );
}

function isPrivateIPv6(addr: string): boolean {
    const lower = addr.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    if (lower === "::ffff:0:0" || lower.startsWith("::ffff:0:")) return true;
    if (lower.startsWith("::ffff:")) {
        return isPrivateIPv4(lower.slice("::ffff:".length));
    }
    if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
    return false;
}

function isPrivateAddress(ip: string): boolean {
    return isIP(ip) === 4 ? isPrivateIPv4(ip) : isPrivateIPv6(ip);
}

export async function assertPublicUrl(rawUrl: string): Promise<void> {
    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        throw new Error("Invalid URL");
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("Only http/https URLs are allowed");
    }
    if (parsed.username || parsed.password) {
        throw new Error("URL must not contain credentials");
    }

    let host = parsed.hostname.toLowerCase();
    if (host.startsWith("[") && host.endsWith("]")) {
        host = host.slice(1, -1);
    }
    if (isIP(host)) {
        if (isPrivateAddress(host)) {
            throw new Error("Private IP addresses are not allowed");
        }
        return;
    }

    if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localhost")) {
        throw new Error("Hostname is not allowed");
    }

    let addresses: string[] = [];
    try {
        const resolved = await lookup(host, { all: true });
        addresses = resolved.map((r) => r.address);
    } catch {
        throw new Error("Could not resolve hostname");
    }

    if (addresses.length === 0) {
        throw new Error("Could not resolve hostname");
    }

    for (const address of addresses) {
        if (isPrivateAddress(address)) {
            throw new Error(`Hostname resolves to a private/loopback address (${address})`);
        }
    }
}