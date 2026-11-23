"""Run offline functional checks for the tools image as its normal user."""

import json
import os
import re
import shutil
import signal
import socket
import sqlite3
import subprocess
import tempfile
import threading
import time
from contextlib import contextmanager
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit


def free_port() -> int:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def wait_for(predicate, label: str, timeout: float = 15) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() >= deadline:
            raise RuntimeError(f"Timed out waiting for {label}")
        time.sleep(0.05)


@contextmanager
def spawned(command: list[str], log_path: Path, cwd: Path):
    with log_path.open("wb") as output:
        process = subprocess.Popen(
            command,
            cwd=cwd,
            stdout=output,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        try:
            yield process
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)
            output.flush()


def port_open(port: int) -> bool:
    with socket.socket() as probe_socket:
        probe_socket.settimeout(0.1)
        return probe_socket.connect_ex(("127.0.0.1", port)) == 0


def main() -> None:
    assert os.getuid() == 10000, "Run with the final image's default user"
    assert not Path("/workspace/.sage").exists(), "Validate Sage from a clean user home"
    assert Path("/opt/sage/lib/jvm").resolve() == Path("/usr/lib/jvm/java-25-openjdk-amd64")
    for path in ("/opt/bbx", "/opt/envd", "/opt/traffic", "/etc/sudoers.d/bbx-agents"):
        assert not Path(path).exists(), f"Old platform payload remains: {path}"
    root = Path(tempfile.mkdtemp(prefix="ctf-smoke-", dir="/workspace"))
    results = []

    def probe(name, command, contains=None, timeout=90, input_text=None):
        start = time.monotonic()
        process = subprocess.Popen(
            command,
            cwd=root,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            stdin=subprocess.PIPE if input_text is not None else None,
            text=True,
            start_new_session=True,
        )
        timed_out = False
        try:
            stdout, stderr = process.communicate(input=input_text, timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(process.pid, signal.SIGKILL)
            stdout, stderr = process.communicate()
        passed = not timed_out and process.returncode == 0
        if contains is not None:
            passed = passed and contains in stdout + stderr
        record = {
            "name": name,
            "passed": passed,
            "command": command,
            "duration_seconds": round(time.monotonic() - start, 3),
            "timed_out": timed_out,
            "exit_code": process.returncode,
            "stdout": stdout[-4000:],
            "stderr": stderr[-4000:],
        }
        results.append(record)
        print(json.dumps(record), flush=True)
        return passed

    manifest = json.loads(Path("/opt/ctf-tools/manifest.json").read_text())
    for name in manifest["commands"]:
        assert shutil.which(name), f"Missing command: {name}"

    tests = {
        "container_sudo": [
            "python3",
            "-c",
            "import subprocess; "
            "assert subprocess.check_output(['sudo','-n','id','-u']).strip()==b'0'",
        ],
        "sage_factor_lll": [
            "sage",
            "-c",
            "assert list(factor(91))==[(7,1),(13,1)]; "
            "assert matrix(ZZ,[[1,2],[3,4]]).LLL().nrows()==2",
        ],
        "sage_scientific": [
            "/opt/sage/bin/python",
            "-c",
            "import numpy as n; from scipy.linalg import det; "
            "assert int(n.dot([1,2],[3,4]))==11; assert abs(det([[1,2],[3,4]])+2)<1e-8",
        ],
        "sage_java_path": ["/opt/sage/lib/jvm/bin/java", "--version"],
        "pwntools": ["python3", "-c", "from pwn import p64,u64; assert u64(p64(42))==42"],
        "z3": [
            "python3",
            "-c",
            "import z3; x=z3.Int('x'); s=z3.Solver(); s.add(x==4); assert s.check()==z3.sat",
        ],
        "crypto": [
            "python3",
            "-c",
            "from Crypto.Cipher import AES; import gmpy2,sympy; "
            "from fpylll import IntegerMatrix,LLL; "
            "assert len(AES.new(bytes(16),AES.MODE_ECB).encrypt(bytes(16)))==16; "
            "assert gmpy2.invert(3,7)==5; assert sympy.factorint(91)=={7:1,13:1}; "
            "m=IntegerMatrix.from_matrix([[1,2],[3,4]]); LLL.reduction(m)",
        ],
        "sage_crypto": [
            "/opt/sage/bin/python",
            "-c",
            "from Crypto.Cipher import AES; "
            "plaintext=bytes(range(16)); "
            "cipher=AES.new(bytes(16),AES.MODE_ECB); "
            "assert cipher.decrypt(cipher.encrypt(plaintext))==plaintext",
        ],
        "lua51": [
            "lua5.1",
            "-e",
            "assert(_VERSION=='Lua 5.1'); "
            "assert(loadstring('return 6*7')()==42); "
            "print('LUA51_OK')",
        ],
        "angr_symbolic_step": [
            "python3",
            "-c",
            "import angr; p=angr.Project('/bin/true',auto_load_libs=False); "
            "s=p.factory.simgr(p.factory.entry_state()); s.step()",
        ],
        "opencv": [
            "python3",
            "-c",
            "import cv2,numpy as n; assert cv2.imencode('.png',n.zeros((4,4,3),dtype=n.uint8))[0]",
        ],
        "scapy": [
            "python3",
            "-c",
            "from scapy.all import Ether,IP,TCP,wrpcap; "
            "wrpcap('test.pcap',Ether()/IP(dst='127.0.0.1')/TCP(dport=8080))",
        ],
        "web_python": [
            "python3",
            "-c",
            "import requests,httpx; from bs4 import BeautifulSoup; "
            "assert BeautifulSoup('<b>ok</b>','html.parser').b.text=='ok'",
        ],
        "node_sqlite": [
            "node",
            "-e",
            "const {DatabaseSync}=require('node:sqlite');"
            "const d=new DatabaseSync(':memory:');"
            "if(d.prepare('select 4 as x').get().x!==4)process.exit(1)",
        ],
        "john": ["john", "--test=1", "--format=raw-md5"],
        "pwndbg": [
            "pwndbg",
            "-q",
            "--batch",
            "-ex",
            "python import pwndbg; print('PWNDBG_OK')",
            "-ex",
            "file /bin/true",
        ],
        "gef": ["gef", "-q", "--batch", "-ex", "gef version"],
        "ruby_pwn_helpers": ["ruby", "-e", "require 'seccomp-tools'; require 'one_gadget'"],
        "nmap_version": ["nmap", "--version"],
        "sqlmap_version": ["sqlmap", "--version"],
        "dirsearch_version": ["dirsearch", "--version"],
        "bkcrack": ["bkcrack", "--version"],
        "volatility3": ["vol", "--help"],
        "chisel_version": ["chisel", "--version"],
        "smbclient_version": ["smbclient", "--version"],
        "rpcclient_help": ["rpcclient", "--help"],
        "ldapsearch_version": ["ldapsearch", "-VV"],
        "mariadb_version": ["mariadb", "--version"],
        "redis_version": ["redis-cli", "--version"],
        "pymongo_import": [
            "python3",
            "-c",
            "import importlib.metadata,pymongo,bson; "
            "assert importlib.metadata.version('pymongo')=='4.19.0'",
        ],
        "impacket_import": [
            "python3",
            "-c",
            "import importlib.metadata,impacket; "
            "assert importlib.metadata.version('impacket')=='0.13.1'",
        ],
        "impacket_scripts": [
            "bash",
            "-lc",
            "for tool in impacket-smbclient impacket-secretsdump impacket-psexec "
            "impacket-wmiexec impacket-atexec impacket-samrdump impacket-lookupsid "
            "impacket-GetADUsers impacket-GetNPUsers impacket-GetUserSPNs "
            "impacket-getTGT impacket-getST impacket-findDelegation "
            "impacket-ntlmrelayx impacket-smbserver impacket-mssqlclient; do "
            'command -v "$tool" >/dev/null && "$tool" -h >/dev/null 2>&1 || exit 1; '
            "done",
        ],
        "netexec_version": [
            "python3",
            "-c",
            "import importlib.metadata; assert importlib.metadata.version('netexec')=='1.5.1'",
        ],
        "netexec_modules": [
            "bash",
            "-lc",
            "for module in smb ldap winrm mssql ssh; do "
            'nxc "$module" --help >/dev/null || exit 1; done',
        ],
    }
    for name, command in tests.items():
        probe(name, command)

    math_program = root / "sage_math.py"
    math_program.write_text(
        "from sage.all import *\n"
        "from sage.misc.cython import cython_lambda\n"
        "from sage.repl.user_globals import set_globals\n"
        "assert list(Integer(1009*1013).factor())==[(1009,1),(1013,1)]\n"
        "assert GF(101)(7)**100==1\n"
        "R=PolynomialRing(QQ,names=('x','y')); x,y=R.gens()\n"
        "assert len(R.ideal([x*y-1,y*y-1]).groebner_basis())==2\n"
        "assert int(pari(104729).isprime())==1\n"
        "x=var('x'); assert integrate(x**2,x)==x**3/3\n"
        "assert PermutationGroup([(1,2,3),(1,2)]).order()==6\n"
        "set_globals(globals()); f=cython_lambda('double x','x*x'); assert f(3.)==9.\n"
        "from sage.features.jmol import JmolDataJar\n"
        "assert JmolDataJar().is_present()\n"
        "print('SAGE_CYTHON_MATH_OK')\n"
    )
    probe(
        "sage_cython_math",
        ["sage-python", str(math_program)],
        "SAGE_CYTHON_MATH_OK",
        timeout=150,
    )
    probe(
        "gap_terminal_help",
        ["/opt/sage/bin/gap", "-q"],
        "returns the size of the list",
        input_text="?Size\n?1\nQUIT;\n",
    )
    probe(
        "maxima_terminal_help",
        ["/opt/sage/bin/maxima", "--very-quiet", "--batch-string=describe(integrate)$ quit();"],
        "Attempts to symbolically compute",
    )
    probe(
        "jmol_headless",
        [
            "/opt/sage/bin/java",
            "-Djava.awt.headless=true",
            "-jar",
            "/opt/sage/share/jmol/JmolData.jar",
            "-n",
            "-i",
            "-j",
            "print 6*7; exit;",
        ],
        "42",
    )

    www = root / "www"
    www.mkdir()
    (www / "hello.txt").write_text("CTF_LOCAL_WEB")
    words = root / "words.txt"
    words.write_text("hello.txt\n")
    database = root / "fixture.sqlite"
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)")
        connection.execute("INSERT INTO items VALUES (1, 'CTF_SQLMAP_OK')")

    class QuietHandler(SimpleHTTPRequestHandler):
        def log_message(self, format, *args):
            pass

        def handle(self):
            try:
                super().handle()
            except ConnectionResetError:
                # TCP connect scans may close before sending an HTTP request.
                pass

        def do_GET(self):
            request = urlsplit(self.path)
            if request.path != "/item":
                return super().do_GET()
            value = parse_qs(request.query).get("id", ["1"])[0]
            try:
                with sqlite3.connect(database) as connection:
                    # Deliberately injectable fixture, bound only to container loopback.
                    rows = connection.execute(f"SELECT name FROM items WHERE id={value}").fetchall()
                body = "<html><body>Items: " + ",".join(row[0] for row in rows) + "</body></html>"
            except sqlite3.Error as error:
                body = "<html><body>SQLite error: " + str(error) + "</body></html>"
            payload = body.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=str(www)))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = "http://127.0.0.1:" + str(server.server_port)
    try:
        probe(
            "nmap_local",
            [
                "nmap",
                "-sT",
                "-Pn",
                "-n",
                "--max-retries",
                "0",
                "--host-timeout",
                "15s",
                "-p",
                str(server.server_port),
                "-oG",
                "-",
                "127.0.0.1",
            ],
            f"{server.server_port}/open/tcp/",
            30,
        )
        probe(
            "sqlmap_local",
            [
                "sqlmap",
                "-u",
                url + "/item?id=1",
                "-p",
                "id",
                "--batch",
                "--dbms=SQLite",
                "--technique=B",
                "--test-filter=AND boolean-based blind",
                "--threads=1",
                "--timeout=3",
                "--retries=0",
                "--ignore-proxy",
                "--disable-coloring",
                "--flush-session",
                "--output-dir=" + str(root / "sqlmap"),
            ],
            "Parameter: id (GET)",
            45,
        )
        probe(
            "ffuf_local",
            [
                "ffuf",
                "-u",
                url + "/FUZZ",
                "-w",
                str(words),
                "-t",
                "1",
                "-timeout",
                "3",
                "-noninteractive",
                "-of",
                "json",
                "-o",
                str(root / "ffuf.json"),
            ],
        )
        probe(
            "ffuf_validate",
            [
                "python3",
                "-c",
                "import json; "
                "d=json.load(open('ffuf.json')); "
                "assert any(x['status']==200 for x in d['results'])",
            ],
        )
        probe(
            "gobuster_local",
            ["gobuster", "dir", "-u", url, "-w", str(words), "-t", "1", "--no-progress", "-q"],
            "hello.txt",
        )
        probe(
            "nmap_syn_scan",
            [
                "sudo",
                "-n",
                "nmap",
                "-sS",
                "-Pn",
                "-n",
                "--max-retries",
                "0",
                "--host-timeout",
                "15s",
                "-p",
                str(server.server_port),
                "-oG",
                "-",
                "127.0.0.1",
            ],
            f"{server.server_port}/open/tcp/",
            30,
        )
        probe("tcpdump_capable", ["sudo", "-n", "tcpdump", "-D"], ".")
        probe(
            "no_cap_net_admin",
            [
                "bash",
                "-lc",
                "if ip link add ctf-smoke-link type dummy 2>ip-link.err; then "
                "ip link delete ctf-smoke-link; exit 1; fi; "
                "grep -q 'Operation not permitted' ip-link.err",
            ],
        )

        chisel_server_port = free_port()
        socks_port = free_port()
        remote_port = free_port()
        server_log = root / "chisel-server.log"
        client_log = root / "chisel-client.log"
        reverse_log = root / "chisel-reverse.log"
        with spawned(
            [
                "chisel",
                "server",
                "--host",
                "127.0.0.1",
                "--port",
                str(chisel_server_port),
                "--reverse",
                "--socks5",
            ],
            server_log,
            root,
        ):
            wait_for(
                lambda: "server: Listening" in server_log.read_text(errors="ignore"),
                "Chisel server",
            )
            fingerprint = re.search(
                r"Fingerprint\s+(\S+)",
                server_log.read_text(errors="ignore"),
            )
            assert fingerprint, server_log.read_text(errors="ignore")
            with spawned(
                [
                    "chisel",
                    "client",
                    "--fingerprint",
                    fingerprint.group(1),
                    f"http://127.0.0.1:{chisel_server_port}",
                    f"127.0.0.1:{socks_port}:socks",
                ],
                client_log,
                root,
            ):
                wait_for(lambda: port_open(socks_port), "Chisel SOCKS listener")
                probe(
                    "chisel_socks",
                    [
                        "python3",
                        "-c",
                        "import socket,struct; "
                        f"s=socket.create_connection(('127.0.0.1',{socks_port}),timeout=5); "
                        "s.sendall(b'\\x05\\x01\\x00'); assert s.recv(2)==b'\\x05\\x00'; "
                        f"s.sendall(b'\\x05\\x01\\x00\\x01'+socket.inet_aton('127.0.0.1')+"
                        f"struct.pack('!H',{server.server_port})); "
                        "assert s.recv(4)==b'\\x05\\x00\\x00\\x01'; s.recv(6); "
                        "s.sendall(b'GET /hello.txt HTTP/1.0\\r\\nHost: 127.0.0.1\\r\\n\\r\\n'); "
                        "data=b''.join(iter(lambda:s.recv(4096),b'')); "
                        "assert b'CTF_LOCAL_WEB' in data",
                    ],
                )
                probe(
                    "curl_socks",
                    [
                        "curl",
                        "--fail",
                        "--silent",
                        "--show-error",
                        "--socks5-hostname",
                        f"127.0.0.1:{socks_port}",
                        url + "/hello.txt",
                    ],
                    "CTF_LOCAL_WEB",
                )
                proxy_config = root / "proxychains.conf"
                proxy_config.write_text(
                    "strict_chain\n"
                    "proxy_dns\n"
                    "tcp_read_time_out 15000\n"
                    "tcp_connect_time_out 8000\n"
                    "[ProxyList]\n"
                    f"socks5 127.0.0.1 {socks_port}\n"
                )
                probe(
                    "proxychains_http",
                    [
                        "proxychains4",
                        "-q",
                        "-f",
                        str(proxy_config),
                        "curl",
                        "--fail",
                        "--silent",
                        "--show-error",
                        url + "/hello.txt",
                    ],
                    "CTF_LOCAL_WEB",
                    30,
                )
                probe(
                    "pysocks_http",
                    [
                        "python3",
                        "-c",
                        "import socks; "
                        "s=socks.socksocket(); "
                        f"s.set_proxy(socks.SOCKS5,'127.0.0.1',{socks_port},rdns=True); "
                        f"s.connect(('127.0.0.1',{server.server_port})); "
                        "s.sendall(b'GET /hello.txt HTTP/1.0\\r\\nHost: 127.0.0.1\\r\\n\\r\\n'); "
                        "data=b''.join(iter(lambda:s.recv(4096),b'')); "
                        "assert b'CTF_LOCAL_WEB' in data",
                    ],
                )
                probe(
                    "nmap_socks",
                    [
                        "proxychains4",
                        "-q",
                        "-f",
                        str(proxy_config),
                        "nmap",
                        "-sT",
                        "-Pn",
                        "-n",
                        "--max-retries",
                        "0",
                        "--host-timeout",
                        "15s",
                        "-p",
                        str(server.server_port),
                        "-oG",
                        "-",
                        "127.0.0.1",
                    ],
                    f"{server.server_port}/open/tcp/",
                    30,
                )
            with spawned(
                [
                    "chisel",
                    "client",
                    "--fingerprint",
                    fingerprint.group(1),
                    f"http://127.0.0.1:{chisel_server_port}",
                    f"R:{remote_port}:127.0.0.1:{server.server_port}",
                ],
                reverse_log,
                root,
            ):
                wait_for(lambda: port_open(remote_port), "Chisel remote forward")
                probe(
                    "chisel_remote_forward",
                    [
                        "curl",
                        "--fail",
                        "--silent",
                        "--show-error",
                        f"http://127.0.0.1:{remote_port}/hello.txt",
                    ],
                    "CTF_LOCAL_WEB",
                )
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

    probe(
        "tshark_offline", ["tshark", "-r", "test.pcap", "-T", "fields", "-e", "tcp.dstport"], "8080"
    )
    (root / "hello.c").write_text(
        '#include <stdio.h>\nint main(void){puts("CTF_SMOKE_OK");return 0;}\n'
    )
    probe("gcc_compile", ["gcc", "-o", "hello", "hello.c"])
    probe("compiled_elf", [str(root / "hello")], "CTF_SMOKE_OK")
    probe("nm_symbols", ["nm", "-g", "hello"], "main")
    (root / "qiling-exit.c").write_text("int main(void){return 42;}\n")
    probe("qiling_build", ["gcc", "-static", "-o", "qiling-exit", "qiling-exit.c"])
    qiling_program = root / "qiling-exit"
    probe(
        "qiling_elf_x86_64",
        [
            "qiling-python",
            "-c",
            "from qiling import Qiling; "
            "from qiling.const import QL_VERBOSE; "
            f"ql=Qiling([{str(qiling_program)!r}], '/', verbose=QL_VERBOSE.DISABLED); "
            "ql.run(); assert ql.os.exit_code == 42; print('QILING_OK')",
        ],
        "QILING_OK",
    )
    probe(
        "gdb_run",
        ["gdb", "-q", "-nx", "--batch", "-ex", "file hello", "-ex", "run"],
        "CTF_SMOKE_OK",
    )
    probe("radare2_analysis", ["r2", "-q", "-c", "aaa; afl", "hello"], "main")
    probe("checksec", ["checksec", "--file=" + str(root / "hello")])
    probe(
        "ropgadget",
        ["ROPgadget", "--binary", str(root / "hello"), "--only", "ret"],
        "Unique gadgets",
    )
    probe(
        "ghidra_headless",
        [
            "/usr/share/ghidra/support/analyzeHeadless",
            str(root),
            "project",
            "-import",
            str(root / "hello"),
            "-analysisTimeoutPerFile",
            "10",
            "-deleteProject",
        ],
        "Analysis succeeded",
        120,
    )
    (root / "Hello.java").write_text(
        "public class Hello { public static void main(String[] a){"
        'System.out.println("CTF_JAVA_OK");}}'
    )
    probe("java_compile", ["javac", "--release", "11", "Hello.java"])
    probe("java_run", ["java", "Hello"], "CTF_JAVA_OK")
    probe("jar_pack", ["jar", "--create", "--file", "hello.jar", "Hello.class"])
    probe("jadx_decompile", ["jadx", "-d", str(root / "decompiled"), str(root / "hello.jar")])
    probe(
        "jadx_validate",
        [
            "python3",
            "-c",
            "from pathlib import Path; p=list(Path('decompiled').rglob('Hello.java')); "
            "assert p and 'CTF_JAVA_OK' in p[0].read_text()",
        ],
    )
    probe("qr_create", ["qrencode", "-o", "qr.png", "CTF_QR_OK"])
    probe("qr_read", ["zbarimg", "--quiet", "qr.png"], "CTF_QR_OK")
    probe("zsteg", ["zsteg", "--no-color", "qr.png"])
    probe("pngcheck", ["pngcheck", "qr.png"])
    probe("exiftool", ["exiftool", "-ImageWidth", "qr.png"], "Image Width")
    probe("imagemagick", ["magick", "qr.png", "-resize", "50%", "small.png"])
    probe(
        "audio_generate",
        ["sox", "-n", "-r", "8000", "-c", "1", "tone.wav", "synth", "0.2", "sine", "440"],
    )
    probe("audio_convert", ["ffmpeg", "-v", "error", "-i", "tone.wav", "tone.flac"])
    probe(
        "audio_probe",
        ["ffprobe", "-v", "error", "-show_entries", "stream=codec_name", "tone.flac"],
        "flac",
    )
    probe(
        "dtmf_generate",
        [
            "sox",
            "-n",
            "-r",
            "22050",
            "-c",
            "1",
            "-b",
            "16",
            "dtmf.wav",
            "synth",
            "0.4",
            "sine",
            "770",
            "sine",
            "1336",
            "channels",
            "1",
            "gain",
            "-6",
            "pad",
            "0.1",
            "0.1",
        ],
    )
    probe(
        "multimon_dtmf",
        ["multimon-ng", "-q", "-c", "-a", "DTMF", "-t", "wav", "dtmf.wav"],
        "DTMF: 5",
    )
    (root / "payload.txt").write_text("CTF_ARCHIVE_OK")
    probe("archive_pack", ["7z", "a", "-bd", "archive.7z", "payload.txt"])
    probe("archive_unpack", ["7z", "x", "-bd", "-ounpack", "archive.7z"])
    probe("archive_validate", ["cmp", "payload.txt", "unpack/payload.txt"])
    probe(
        "xz_roundtrip",
        ["bash", "-lc", "printf 'CTF_XZ_OK\\n' | xz -c | xz -dc | grep -Fx CTF_XZ_OK"],
    )
    pdf_stream = b"BT /F1 12 Tf 10 50 Td (CTF_PDF_OK) Tj ET\n"
    pdf_objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R "
        b"/Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length "
        + str(len(pdf_stream)).encode()
        + b" >>\nstream\n"
        + pdf_stream
        + b"endstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    pdf = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for number, content in enumerate(pdf_objects, 1):
        offsets.append(len(pdf))
        pdf.extend(str(number).encode() + b" 0 obj\n" + content + b"\nendobj\n")
    xref = len(pdf)
    pdf.extend(b"xref\n0 6\n0000000000 65535 f \n")
    for offset in offsets[1:]:
        pdf.extend(f"{offset:010d} 00000 n \n".encode())
    pdf.extend(
        b"trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n" + str(xref).encode() + b"\n%%EOF\n"
    )
    (root / "fixture.pdf").write_bytes(pdf)
    probe("pdf_info", ["pdfinfo", "fixture.pdf"], "Pages:")
    probe("pdf_text", ["pdftotext", "fixture.pdf", "-"], "CTF_PDF_OK")
    probe("pdf_structure", ["qpdf", "--check", "fixture.pdf"])
    probe(
        "zipcrypto_pack",
        [
            "7z",
            "a",
            "-bd",
            "-tzip",
            "-mem=ZipCrypto",
            "-mx=0",
            "-pCTF_SMOKE_PASSWORD",
            "protected.zip",
            "payload.txt",
        ],
    )
    probe(
        "zipcrypto_validate",
        [
            "python3",
            "-c",
            "from zipfile import ZipFile; z=ZipFile('protected.zip'); "
            "assert z.getinfo('payload.txt').flag_bits & 1; "
            "assert z.read('payload.txt',pwd=b'CTF_SMOKE_PASSWORD')==b'CTF_ARCHIVE_OK'",
        ],
    )
    probe(
        "bkcrack_decrypt",
        [
            "bkcrack",
            "--password",
            "CTF_SMOKE_PASSWORD",
            "-C",
            "protected.zip",
            "-D",
            "decrypted.zip",
        ],
        timeout=15,
    )
    probe(
        "bkcrack_validate",
        [
            "python3",
            "-c",
            "from zipfile import ZipFile; z=ZipFile('decrypted.zip'); "
            "assert not (z.getinfo('payload.txt').flag_bits & 1); "
            "assert z.read('payload.txt')==b'CTF_ARCHIVE_OK'",
        ],
    )
    summary = {
        "uid": os.getuid(),
        "gid": os.getgid(),
        "path": os.environ["PATH"],
        "sage_first_run": True,
        "passed": all(result["passed"] for result in results),
        "results": results,
    }
    print(json.dumps({"final": summary}), flush=True)
    shutil.rmtree(root)
    assert summary["passed"], "One or more tool checks failed"


if __name__ == "__main__":
    main()
