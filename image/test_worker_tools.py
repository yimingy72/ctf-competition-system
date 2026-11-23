import unittest
from pathlib import Path

from tool_manifest import COMMANDS, WORKER_TOOLS_REQUIRED_COMMANDS, render_worker_tools


class WorkerToolsTests(unittest.TestCase):
    def test_checked_in_summary_matches_generator(self) -> None:
        expected = Path(__file__).parents[1] / "worker-tools.txt"
        rendered = render_worker_tools(
            {
                "python": "Python 3.14.10",
                "node": "v22.21.1",
                "sage": "10.9",
                "qiling": "1.4.6",
                "lua": "Lua 5.1.5",
                "chisel": "1.12.0",
                "impacket": "0.13.1",
                "netexec": "1.5.1",
            }
        )
        self.assertEqual(rendered, expected.read_text())

    def test_manifest_scope_contains_advertised_base_commands(self) -> None:
        for command in WORKER_TOOLS_REQUIRED_COMMANDS:
            with self.subTest(command=command):
                self.assertIn(command, COMMANDS)

    def test_summary_uses_verified_absolute_paths(self) -> None:
        summary = (Path(__file__).parents[1] / "worker-tools.txt").read_text()
        for path in (
            "/usr/bin/python3",
            "/usr/local/bin/sage-python",
            "/opt/sage/bin/python",
            "/usr/local/bin/node",
            "/usr/local/bin/sage",
            "/usr/local/bin/qiling-python",
            "/usr/bin/lua5.1",
            "/usr/local/bin/chisel",
            "/usr/share/ghidra/support/analyzeHeadless",
            "/usr/share/john/password.lst",
        ):
            with self.subTest(path=path):
                self.assertIn(path, summary)

    def test_summary_keeps_only_pivoting_routes_and_shared_impact_rules(self) -> None:
        summary = (Path(__file__).parents[1] / "worker-tools.txt").read_text()
        for text in (
            "proxychains4",
            "Impacket",
            "NetExec 使用 nxc",
            "CAP_NET_RAW",
            "没有 CAP_NET_ADMIN",
            "proxychains 只代理 TCP",
            "用同题 Fact 记录入口",
        ):
            with self.subTest(text=text):
                self.assertIn(text, summary)
        self.assertLess(len(summary.encode()), 1800)


if __name__ == "__main__":
    unittest.main()
