"""Install the small, pinned tools not supplied by the audited Kali package set."""

import gzip
import hashlib
import json
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
from pathlib import Path
from urllib.request import urlopen


def download(source: dict) -> bytes:
    for attempt in range(3):
        try:
            with urlopen(source["url"], timeout=60) as response:
                data = response.read()
            break
        except OSError:
            if attempt == 2:
                raise
            time.sleep(2)
    else:
        raise RuntimeError("Download did not complete")
    if "bytes" in source and len(data) != source["bytes"]:
        raise ValueError("Size mismatch: " + source["url"])
    if "sha256" in source and hashlib.sha256(data).hexdigest() != source["sha256"]:
        raise ValueError("SHA-256 mismatch: " + source["url"])
    if "git_blob_sha" in source:
        git_data = b"blob " + str(len(data)).encode() + b"\0" + data
        if hashlib.sha1(git_data).hexdigest() != source["git_blob_sha"]:
            raise ValueError("Git blob mismatch: " + source["url"])
    return data


def verify_local(path: Path, source: dict) -> Path:
    data = path.read_bytes()
    if "bytes" in source and len(data) != source["bytes"]:
        raise ValueError(f"Size mismatch: {path}")
    if hashlib.sha256(data).hexdigest() != source["sha256"]:
        raise ValueError(f"SHA-256 mismatch: {path}")
    return path


def install_qiling(sources: dict) -> None:
    source = sources["qiling_core"]
    vendor = Path("/opt/ctf-tools") / source["vendor"]
    wheels = []
    for package in source["packages"]:
        wheel = verify_local(vendor / package["filename"], package)
        if wheel.suffix == ".whl":
            wheels.append(wheel)
    if len(wheels) != len(source["packages"]):
        raise RuntimeError("Qiling vendor set must be wheel-only")
    venv = Path(source["venv"])
    if not venv.exists():
        subprocess.run([sys.executable, "-m", "venv", str(venv)], check=True)
    subprocess.run(
        [
            str(venv / "bin/python"),
            "-m",
            "pip",
            "install",
            "--no-index",
            "--no-deps",
            "--disable-pip-version-check",
            *map(str, wheels),
        ],
        check=True,
    )


def install_sage_crypto(sources: dict) -> None:
    source = sources["pycryptodome_sage"]
    wheel = verify_local(Path("/opt/ctf-tools") / source["vendor"] / source["filename"], source)
    subprocess.run(
        [
            source["target"],
            "-m",
            "pip",
            "install",
            "--no-index",
            "--no-deps",
            "--disable-pip-version-check",
            str(wheel),
        ],
        check=True,
    )


def install_apt_tools(sources: dict) -> None:
    with tempfile.TemporaryDirectory(prefix="ctf-apt-tools-") as directory:
        packages = []
        for name, source in sources["apt_tools"].items():
            destination = Path(directory) / f"{name}.deb"
            destination.write_bytes(download(source))
            packages.append(str(destination))
        subprocess.run(
            ["apt-get", "install", "--yes", "--no-install-recommends", *packages],
            check=True,
        )


def install_chisel(sources: dict) -> None:
    source = sources["chisel"]
    destination = Path("/usr/local/bin/chisel")
    destination.write_bytes(gzip.decompress(download(source)))
    destination.chmod(0o755)


def main() -> None:
    sources = json.loads(Path("/opt/ctf-tools/sources.json").read_text())
    with tempfile.TemporaryDirectory(prefix="ctf-build-") as temporary:
        root = Path(temporary)
        for name in ("volatility3", "zsteg", "opencv"):
            source = sources[name]
            package = root / source["filename"]
            package.write_bytes(download(source))
            if name != "zsteg":
                subprocess.run(
                    [
                        "python3",
                        "-m",
                        "pip",
                        "install",
                        "--no-cache-dir",
                        "--break-system-packages",
                        str(package),
                    ],
                    check=True,
                )
            else:
                subprocess.run(["gem", "install", "--no-document", str(package)], check=True)
        source = sources["bkcrack"]
        archive = root / "bkcrack.tar.gz"
        archive.write_bytes(download(source))
        with tarfile.open(archive) as stream:
            stream.extractall(root, filter="data")
        project = root / ("bkcrack-" + source["version"])
        build = root / "build"
        subprocess.run(
            ["cmake", "-S", str(project), "-B", str(build), "-DCMAKE_BUILD_TYPE=Release"],
            check=True,
        )
        subprocess.run(["cmake", "--build", str(build), "--parallel", "2"], check=True)
        shutil.copy2(build / "src/bkcrack", "/usr/local/bin/bkcrack")
        license_path = Path("/usr/share/doc/bkcrack")
        license_path.mkdir(parents=True, exist_ok=True)
        shutil.copy2(project / "license.txt", license_path / "copyright")

    wordlists = []
    license_source = sources["seclists"]["license"]
    license_path = Path("/usr/share/seclists/LICENSE")
    license_path.parent.mkdir(parents=True, exist_ok=True)
    license_path.write_bytes(download(license_source))
    for source in sources["seclists"]["wordlists"]:
        data = download(source)
        path = Path("/usr/share/seclists") / source["path"]
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        wordlists.append(
            {
                "path": str(path),
                "bytes": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
                "source_url": source["url"],
            }
        )
    Path("/opt/ctf-tools/wordlists.json").write_text(
        json.dumps(
            {
                "kind": "selected-subset",
                "commit": sources["seclists"]["commit"],
                "files": wordlists,
            },
            indent=2,
        )
        + "\n"
    )
    install_apt_tools(sources)
    install_chisel(sources)
    install_qiling(sources)
    install_sage_crypto(sources)
    shutil.rmtree("/opt/ctf-tools/vendor")


if __name__ == "__main__":
    main()
