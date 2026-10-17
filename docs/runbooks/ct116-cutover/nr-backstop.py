#!/usr/bin/env python3
"""Temporary raw NR feed capture (backstop for the CT 116 cutover).

Stdlib only. Subscribes to TD, TRUST movements and VSTP on the NR public broker
and appends every frame, byte-for-byte, to hourly NDJSON files:
  {"received_at": ISO-UTC, "destination": ..., "headers": {...}, "body_b64": ...}
Credentials come from the environment (NR_USERNAME / NR_PASSWORD) and are never
logged. Not durable on purpose: it runs continuously across the cutover window.
"""
import base64, json, os, socket, sys, time, uuid
from datetime import datetime, timezone

HOST, PORT = "publicdatafeeds.networkrail.co.uk", 61618
TOPICS = ["/topic/TD_ALL_SIG_AREA", "/topic/TRAIN_MVT_ALL_TOC", "/topic/VSTP_ALL"]
OUT = os.environ.get("NR_BACKSTOP_DIR", "/root/nr-backstop/data")
HB_MS = 15000


def log(msg):
    print(f"{datetime.now(timezone.utc).isoformat(timespec='seconds')} {msg}", flush=True)


def esc(v):
    return v.replace("\\", "\\\\").replace("\n", "\\n").replace(":", "\\c")


def unesc(v):
    out, i = [], 0
    while i < len(v):
        if v[i] == "\\" and i + 1 < len(v):
            out.append({"n": "\n", "c": ":", "\\": "\\", "r": "\r"}.get(v[i + 1], v[i + 1])); i += 2
        else:
            out.append(v[i]); i += 1
    return "".join(out)


def send_frame(sock, command, headers):
    head = command + "\n" + "".join(f"{k}:{esc(str(v))}\n" for k, v in headers.items()) + "\n"
    sock.sendall(head.encode() + b"\x00")


class Reader:
    def __init__(self, sock):
        self.sock, self.buf = sock, bytearray()

    def _fill(self):
        chunk = self.sock.recv(1 << 20)
        if not chunk:
            raise ConnectionError("broker closed connection")
        self.buf += chunk

    def frame(self):
        while True:
            while self.buf[:1] in (b"\n", b"\r"):      # heart-beats / stray EOLs
                del self.buf[:1]
            idx = self.buf.find(b"\n\n")
            if idx >= 0:
                break
            self._fill()
        lines = self.buf[:idx].decode("utf-8", "replace").replace("\r", "").split("\n")
        command, headers = lines[0], {}
        for line in lines[1:]:
            if ":" in line:
                k, v = line.split(":", 1)
                headers.setdefault(unesc(k), unesc(v))
        start = idx + 2
        if "content-length" in headers:
            end = start + int(headers["content-length"])
            while len(self.buf) < end + 1:
                self._fill()
            body = bytes(self.buf[start:end]); del self.buf[:end + 1]
        else:
            while (nul := self.buf.find(b"\x00", start)) < 0:
                self._fill()
            body = bytes(self.buf[start:nul]); del self.buf[:nul + 1]
        return command, headers, body


class Sink:
    def __init__(self):
        os.makedirs(OUT, exist_ok=True)
        self.hour, self.fh = None, None

    def write(self, rec):
        hour = rec["received_at"][:13]
        if hour != self.hour:
            if self.fh:
                self.fh.close()
            self.fh = open(os.path.join(OUT, f"nr-{hour.replace(':', '')}.ndjson"), "a", buffering=1)
            self.hour = hour
        self.fh.write(json.dumps(rec, separators=(",", ":")) + "\n")


def run_once(user, pw, sink, counts):
    sock = socket.create_connection((HOST, PORT), timeout=60)
    sock.settimeout(HB_MS / 1000 * 3)
    send_frame(sock, "CONNECT", {"accept-version": "1.2", "host": HOST, "login": user, "passcode": pw,
                                 "heart-beat": f"{HB_MS},{HB_MS}", "client-id": f"{user}-backstop-{uuid.uuid4().hex[:8]}"})
    r = Reader(sock)
    cmd, hdrs, body = r.frame()
    if cmd != "CONNECTED":
        raise ConnectionError(f"login failed: {cmd} {hdrs.get('message', '')}")
    log(f"connected ({hdrs.get('server', '?')}), subscribing {len(TOPICS)} topics")
    for i, t in enumerate(TOPICS):
        send_frame(sock, "SUBSCRIBE", {"id": str(i), "destination": t, "ack": "auto"})
    last_hb, last_report = time.time(), time.time()
    while True:
        if time.time() - last_hb > HB_MS / 1000 / 2:
            sock.sendall(b"\n"); last_hb = time.time()
        cmd, hdrs, body = r.frame()
        if cmd == "ERROR":
            raise ConnectionError(f"broker ERROR: {hdrs.get('message', '')}")
        if cmd != "MESSAGE":
            continue
        dest = hdrs.get("destination", "?")
        sink.write({"received_at": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
                    "destination": dest, "headers": hdrs, "body_b64": base64.b64encode(body).decode()})
        counts[dest] = counts.get(dest, 0) + 1
        if time.time() - last_report >= 60:
            log("frames last ~60s: " + ", ".join(f"{k.split('/')[-1]}={v}" for k, v in sorted(counts.items())))
            counts.clear(); last_report = time.time()


def main():
    user, pw = os.environ.get("NR_USERNAME"), os.environ.get("NR_PASSWORD")
    if not user or not pw:
        log("NR_USERNAME / NR_PASSWORD not set - fill in the env file"); sys.exit(2)
    sink, counts, backoff = Sink(), {}, 2
    while True:
        try:
            run_once(user, pw, sink, counts); backoff = 2
        except Exception as e:  # reconnect forever; never log credentials
            log(f"disconnected: {type(e).__name__}: {e}; reconnecting in {backoff}s")
            time.sleep(backoff); backoff = min(backoff * 2, 30)


if __name__ == "__main__":
    main()
