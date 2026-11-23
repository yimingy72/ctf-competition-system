"""Record the installed command paths and package versions without network access."""

import argparse
import hashlib
import json
import platform
import shutil
import subprocess
from pathlib import Path

COMMANDS = """bash python3 node npm ruby php java javac javap jar gcc g++ make cmake
pkg-config nasm gdb pwndbg gef checksec pwn ROPgadget one_gadget
seccomp-tools patchelf r2 jadx sage sage-python qiling-python lua lua5.1 z3 openssl john
exiftool binwalk foremost steghide pngcheck magick tshark tcpdump olevba
mmls testdisk 7z unrar curl wget nc socat ssh dig ffuf gobuster nmap sqlmap
dirsearch sox ffmpeg ffprobe multimon-ng zbarimg qrencode xxd qpdf pdfinfo
pdftotext bkcrack zsteg vol file strings readelf objdump ldd strace ltrace rg
nm xz tar unzip zip base64 diff patch timeout git jq sha256sum
chisel proxychains4 sshpass rlwrap smbclient rpcclient ldapsearch ldapwhoami
mariadb redis-cli nxc netexec
impacket-smbclient impacket-secretsdump impacket-psexec impacket-wmiexec
impacket-atexec impacket-samrdump impacket-lookupsid impacket-GetADUsers
impacket-GetNPUsers impacket-GetUserSPNs impacket-getTGT impacket-getST
impacket-findDelegation impacket-ntlmrelayx impacket-smbserver
impacket-mssqlclient""".split()

CAPABILITY_CHECKS = {
    "pwn": ["gcc_compile", "gdb_run", "pwndbg", "gef", "pwntools", "ropgadget", "nm_symbols"],
    "reverse": ["ghidra_headless", "radare2_analysis", "jadx_validate", "angr_symbolic_step"],
    "emulation": ["qiling_elf_x86_64"],
    "crypto": [
        "sage_factor_lll",
        "sage_scientific",
        "sage_cython_math",
        "gap_terminal_help",
        "maxima_terminal_help",
        "z3",
        "crypto",
        "sage_crypto",
    ],
    "web": [
        "web_python",
        "nmap_local",
        "sqlmap_local",
        "dirsearch_version",
        "ffuf_validate",
        "gobuster_local",
    ],
    "pcap": ["scapy", "tshark_offline"],
    "image_qr": ["opencv", "qr_read", "pngcheck", "exiftool", "imagemagick", "zsteg"],
    "audio": ["audio_convert", "audio_probe", "multimon_dtmf"],
    "archive": ["archive_validate", "xz_roundtrip", "bkcrack_decrypt", "bkcrack_validate"],
    "pdf": ["pdf_info", "pdf_text", "pdf_structure"],
    "password": ["john"],
    "lua": ["lua51"],
    "node_sqlite": ["node_sqlite"],
    "pentest.pivoting": [
        "chisel_socks",
        "chisel_remote_forward",
        "proxychains_http",
        "curl_socks",
        "pysocks_http",
        "nmap_socks",
    ],
    "pentest.smb_ad": [
        "impacket_import",
        "impacket_scripts",
        "smbclient_version",
        "rpcclient_help",
        "ldapsearch_version",
        "netexec_version",
        "netexec_modules",
    ],
    "pentest.database": ["mariadb_version", "redis_version", "pymongo_import"],
    "network.raw_scan": ["nmap_syn_scan", "tcpdump_capable", "no_cap_net_admin"],
}
CAPABILITY_SCOPE = {
    "pwn": "Compile/run a local ELF, debug it, import helpers, and find simple ROP gadgets",
    "reverse": "Ghidra ELF analysis, JADX Java decompilation, radare2, and one angr symbolic step",
    "emulation": (
        "Qiling 1.4.6 executes a static x86-64 Linux ELF offline and reports its exit code"
    ),
    "crypto": "Sage factorization/LLL, NumPy/SciPy, small Z3 and crypto-library fixtures",
    "web": "Local ffuf/gobuster, nmap TCP-connect scan and sqlmap SQLite boolean detection; "
    "dirsearch version only",
    "pcap": "Generate and parse a synthetic offline PCAP; no live capture required",
    "image_qr": "Local PNG/QR generation, decoding, conversion and zsteg invocation",
    "audio": "Local tone/FLAC roundtrip and synthetic DTMF decoding",
    "archive": (
        "7z roundtrip, xz compression/decompression, and bkcrack ZipCrypto decryption "
        "with known local fixture keys"
    ),
    "pdf": "Parse and extract text from a small local PDF and validate its structure",
    "password": "John self-test with bundled formats and dictionary; no speed benchmark",
    "lua": "Lua 5.1 interpreter and loadstring execution",
    "node_sqlite": "An in-memory node:sqlite query",
    "pentest.pivoting": (
        "Chisel 1.12.0 server/client SOCKS and remote forward, proxychains/curl/PySocks "
        "over loopback SOCKS5, and nmap TCP-connect through SOCKS"
    ),
    "pentest.smb_ad": (
        "Impacket 0.13.1 modules and common scripts, SMB/rpcclient/LDAP utilities, "
        "and NetExec module loading"
    ),
    "pentest.database": "MariaDB/Redis clients and the Python PyMongo module",
    "network.raw_scan": (
        "sudo SYN scan and tcpdump execution with CAP_NET_RAW; CAP_NET_ADMIN is absent"
    ),
}

WORKER_TOOLS_REQUIRED_COMMANDS = (
    "file",
    "strings",
    "readelf",
    "objdump",
    "ldd",
    "strace",
    "ltrace",
    "rg",
    "tar",
    "unzip",
    "zip",
    "base64",
    "diff",
    "patch",
    "timeout",
    "nm",
    "xz",
    "lua",
    "lua5.1",
    "qiling-python",
    "chisel",
    "proxychains4",
    "sshpass",
    "rlwrap",
    "smbclient",
    "rpcclient",
    "ldapsearch",
    "mariadb",
    "redis-cli",
    "nxc",
    "impacket-smbclient",
)


def python_modules(executable: str) -> dict:
    names = (
        "pwn qiling z3 Crypto gmpy2 sympy fpylll angr claripy keystone cv2 scapy numpy scipy "
        "httpx bs4 lxml volatility3 pymongo bson ldap3 paramiko socks psycopg"
    ).split()
    code = (
        "import importlib.util,importlib.metadata as m,json; "
        f"names={names!r}; packages=m.packages_distributions(); "
        "print(json.dumps({n:{'present':importlib.util.find_spec(n) is not None,"
        "'packages':{p:m.version(p) for p in packages.get(n,[])}} for n in names}))"
    )
    return json.loads(subprocess.check_output([executable, "-c", code], text=True))


def render_worker_tools(_versions: dict[str, str]) -> str:
    return (
        "容器已预装常用 CTF 工具。按题型直接使用，不要批量执行 --version；"
        "完整命令、路径和版本见 /opt/ctf-tools/manifest.json，仅在不清楚工具路由时读取。\n"
        "基础/WEB：file、binutils、gcc/g++、rg、7z、curl/wget、nc/socat、nmap、sqlmap、"
        "ffuf、gobuster、dirsearch。普通用户扫描使用 nmap -sT。\n"
        "PWN/逆向：gdb、pwndbg/GEF、pwntools、ROPgadget、checksec、angr、radare2、"
        "Ghidra（/usr/share/ghidra/support/analyzeHeadless）、JADX、gcc/g++、javap。\n"
        "密码/模拟：Sage（/usr/local/bin/sage，解释器 /opt/sage/bin/python）、Z3、"
        "PyCryptodome、gmpy2、sympy、fpylll、Qiling（/usr/local/bin/qiling-python）、"
        "Lua 5.1（/usr/bin/lua5.1）。普通 Python 工具统一使用 /usr/bin/python3，"
        "科学计算使用 /usr/local/bin/sage-python。\n"
        "综合渗透：/usr/local/bin/chisel、proxychains4、sshpass、rlwrap、Impacket、"
        "NetExec 使用 nxc、smbclient/rpcclient、ldapsearch、MariaDB/Redis/PyMongo。"
        "proxychains 只代理 TCP。sudo 有 CAP_NET_RAW，没有 CAP_NET_ADMIN。"
        "隧道、反向 shell 或会改变共享环境的命令必须在同一 bash 调用内有界完成，"
        "并用同题 Fact 记录入口、参数、结果和清理状态。\n"
        "文件/取证/杂项：tshark/Scapy、Volatility3、ExifTool、OpenCV/PIL、ImageMagick、"
        "binwalk、foremost、steghide、zsteg、ffmpeg/sox、zbarimg/qrencode、bkcrack、"
        "John（字典 /usr/share/john/password.lst）、Poppler/qpdf。\n"
        "关键运行时：Python /usr/bin/python3，Node /usr/local/bin/node，"
        "Sage /usr/local/bin/sage。\n"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--smoke", type=Path)
    args = parser.parse_args()
    package_list = subprocess.check_output(
        ["dpkg-query", "-W", "-f=${Package}\t${Version}\t${db:Status-Status}\n"], text=True
    )
    packages = {}
    for row in package_list.splitlines():
        name, version, status = row.split("\t", 2)
        if status == "installed":
            packages[name] = version
    versions = {}
    for name, command in {
        "python": ["python3", "--version"],
        "sage_python": ["sage-python", "--version"],
        "node": ["node", "--version"],
        "npm": ["npm", "--version"],
        "sage": ["sage", "--version"],
        "qiling": ["qiling-python", "-c", "import qiling; print(qiling.__version__)"],
        "lua": ["lua5.1", "-v"],
        "chisel": ["chisel", "--version"],
        "impacket": [
            "python3",
            "-c",
            "import importlib.metadata; print(importlib.metadata.version('impacket'))",
        ],
        "netexec": [
            "python3",
            "-c",
            "import importlib.metadata; print(importlib.metadata.version('netexec'))",
        ],
    }.items():
        versions[name] = subprocess.check_output(
            command, text=True, stderr=subprocess.STDOUT
        ).strip()
    smoke = None
    capabilities = {}
    if args.smoke:
        reports = [
            json.loads(row)["final"]
            for row in args.smoke.read_text().splitlines()
            if row.startswith('{"final":')
        ]
        assert len(reports) == 1 and reports[0]["passed"], "Invalid smoke verification"
        smoke = reports[0]
        assert smoke["uid"] == 10000
    checks = {result["name"]: result for result in smoke["results"]} if smoke else {}
    for name, required in CAPABILITY_CHECKS.items():
        passed = all(checks.get(check, {}).get("passed", False) for check in required)
        capabilities[name] = {
            "status": "available" if passed else "conditional",
            "verified_checks": required if passed else [],
            "scope": CAPABILITY_SCOPE[name] if passed else "not yet functionally verified",
        }
    capabilities["gpu"] = {"status": "unavailable", "scope": "No GPU device tested or required"}
    capabilities["memory_forensics_symbols"] = {
        "status": "conditional",
        "scope": "Volatility3 CLI/module smoke only; target-specific symbols may be needed",
    }
    capabilities["competition_harness"] = {
        "status": "unavailable",
        "scope": "Tools image only; no Lead/Worker program",
    }
    capabilities["opencv_gui"] = {"status": "unavailable", "scope": "Headless OpenCV build"}
    capabilities["java_runtime_linker"] = {
        "status": "unavailable",
        "scope": "JDK jmods omitted; java/javac/jar remain",
    }
    capabilities["optional_ghidra_extensions"] = {
        "status": "unavailable",
        "scope": "Uninstalled extension ZIPs omitted; core preserved",
    }
    capabilities["foreign_architecture_execution"] = {
        "status": "conditional",
        "scope": (
            "Qiling 1.4.6 provides user-mode emulation; x86-64 Linux ELF is verified, "
            "while rootfs and syscall coverage varies by target"
        ),
    }
    capabilities["apk_repackaging"] = {
        "status": "unavailable",
        "scope": "APKTool/dex2jar omitted; Java and JADX inspection remain",
    }
    capabilities["sage_browser_notebooks"] = {
        "status": "unavailable",
        "scope": "Browser assets and Pandoc omitted; CLI/IPython/Cython remain",
    }
    capabilities["runtime.shared_execution_facts"] = {
        "status": "available",
        "scope": (
            "Committed same-challenge Fact changes notify the other task members; "
            "tunnels and interactive work should publish reconstructable state as Facts"
        ),
    }
    capabilities["runtime.persistent_process_manager"] = {
        "status": "unavailable",
        "scope": (
            "No managed long-process API. Ordinary bash process groups end with each tool call; "
            "share bounded tunnel setup, verified reachability, and teardown through Facts"
        ),
    }
    manifest = {
        "schema_version": 1,
        "purpose": "tools-base-only",
        "architecture": platform.machine(),
        "path": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "commands": {name: shutil.which(name) for name in COMMANDS},
        "special_paths": {
            "sage_python": "/usr/local/bin/sage-python",
            "sage_python_interpreter": "/opt/sage/bin/python",
            "qiling_python": "/usr/local/bin/qiling-python",
            "lua51": "/usr/bin/lua5.1",
            "ghidra_headless": "/usr/share/ghidra/support/analyzeHeadless",
            "john_dictionary": "/usr/share/john/password.lst",
        },
        "versions": versions,
        "debian_packages": packages,
        "ruby_gems": subprocess.check_output(["gem", "list", "--local"], text=True).splitlines(),
        "extra_sources": json.loads(Path("/opt/ctf-tools/sources.json").read_text()),
        "wordlists": json.loads(Path("/opt/ctf-tools/wordlists.json").read_text()),
        "python_modules": {
            "/usr/bin/python3": python_modules("/usr/bin/python3"),
            "/opt/sage/bin/python": python_modules("/opt/sage/bin/python"),
            "/usr/local/bin/qiling-python": python_modules("/usr/local/bin/qiling-python"),
        },
        "capabilities": capabilities,
        "network_capabilities": {
            "cap_net_raw": {
                "available": bool(
                    checks.get("nmap_syn_scan", {}).get("passed")
                    and checks.get("tcpdump_capable", {}).get("passed")
                ),
                "scope": "Direct SYN scan and packet-capture tooling after sudo",
            },
            "cap_net_admin": {
                "available": False if checks.get("no_cap_net_admin", {}).get("passed") else None,
                "scope": "No TUN creation or routing/interface mutation",
            },
        },
        "verification": smoke,
        "usage_notes": [
            "Use absolute paths for JADX input/output.",
            "Ghidra project paths must not contain hidden dot-prefixed components.",
            "Use sage-python for the scientific environment and matching Cython build tools.",
            "Use qiling-python for the isolated Qiling runtime; "
            "it is not installed in the default Python interpreter.",
            "Use /opt/sage/bin/python or sage-python for Sage-side PyCryptodome.",
            "Chisel and SSH forwarding run as ordinary-user user-space tunnels and need "
            "no CAP_NET_ADMIN.",
            "proxychains is TCP-only; use nmap -sT through SOCKS.",
            "Publish tunnel entry, target, ports, parameters, verification, and teardown "
            "as same-challenge Facts for other Workers.",
            "DEBUGINFOD_URLS is empty; optional debugger downloads are disabled.",
            "No competition Agent harness or challenge answers are included.",
        ],
    }
    destination = args.destination
    destination.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    destination.with_suffix(".sha256").write_text(
        hashlib.sha256(destination.read_bytes()).hexdigest() + "  " + destination.name + "\n"
    )
    destination.with_name("worker-tools.md").write_text(render_worker_tools(versions))


if __name__ == "__main__":
    main()
