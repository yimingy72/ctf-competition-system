import assert from "node:assert/strict";
import test from "node:test";
import { rolePrompt } from "../src/prompts.mjs";

test("connectivity probe prompt is a tool-free one-turn contract", () => {
  const prompt = rolePrompt({
    role: "probe",
    agentId: "probe",
    cwd: "/workspace/ctf-run/work/probe",
    toolSummary: "SHOULD-NOT-APPEAR",
  });
  assert.match(prompt, /只执行一次最小模型回合/);
  assert.match(prompt, /不要调用工具/);
  assert.match(prompt, /不要创建 Agent/);
  assert.match(prompt, /平台会在本回合完成后提取题面 flag/);
  assert.doesNotMatch(prompt, /SHOULD-NOT-APPEAR/);
});

test("Lead prompt makes offline preparation and online slot handling explicit", () => {
  const prompt = rolePrompt({
    role: "lead",
    agentId: "lead",
    cwd: "/workspace/ctf-run/work/lead",
    toolSummary: "TOOL-MANIFEST",
  });
  assert.match(prompt, /container=false/);
  assert.match(prompt, /arena_prepare_offline/);
  assert.match(prompt, /离线优先是 Lead 的比赛调度策略/);
  assert.match(prompt, /平台不替 Lead 硬门禁离线\/在线启动顺序/);
  assert.match(prompt, /在线环境同时最多 3 个是赛事 API 配额/);
  assert.match(prompt, /API 返回 409、environment_limit 或其他配额拒绝时保留原始错误/);
  assert.match(prompt, /close_environment=false 不算释放名额/);
  assert.match(prompt, /arena_start 不会自动下载在线题附件/);
  assert.match(prompt, /必须用 arena_files 查询文件清单并逐个下载/);
  assert.match(prompt, /priority 的 0 最高、3 最低/);
  assert.match(prompt, /为离线题设置更小的 priority/);
  assert.match(prompt, /调度器不会额外硬编码离线题优先/);
  assert.match(prompt, /API 返回 409、environment_limit 或其他配额拒绝时保留原始错误/);
  assert.match(prompt, /只有决定是否增员或怀疑 CPU、内存、磁盘、事件循环存在压力时才读取 resources/);
  assert.match(prompt, /初始团队是 20 个同级 Worker/);
  assert.match(prompt, /你拥有 grow_workers 权限和主动增员的义务/);
  assert.match(prompt, /待援助但无空闲 Worker/);
  assert.match(prompt, /资源仍有安全余量且存在有效并行工作时，应优先调用 grow_workers 扩员/);
  assert.match(prompt, /有新任务积压且没有可分配 Worker/);
  assert.match(prompt, /先使用通知内附带的紧凑 resources/);
  assert.match(prompt, /只有怀疑采样过期或执行状态已变化时才重新读取 resources/);
  assert.match(prompt, /瞬时 idle=0 只表示当时没有完全静默的 Worker/);
  assert.match(prompt, /困难题先只分配一名主 Worker 并进入 assembling\/需要援助/);
  assert.match(prompt, /主 Worker 不应空等第二名成员/);
  assert.match(prompt, /ready 并行 Intent 会自动计入援助容量/);
  assert.match(prompt, /调用 request_assistance 并引用 blocker_fact_id 或 intent_ids/);
  assert.match(prompt, /平台不会为援助绕过新题/);
  assert.match(prompt, /只有没有 new_challenges，且存在空闲 Worker 或你通过 grow_workers 增员后，才加入援助 Worker/);
  assert.match(prompt, /累计解题达到 30 分钟且没有援助时，平台会开放援助/);
  assert.match(prompt, /新未认领任务始终高于援助任务/);
  assert.match(prompt, /request_id 由平台自动生成/);
  assert.match(prompt, /下一次写入前使用最新版本/);
  for (const action of [
    "update_challenge: challenge_id,expected_revision",
    "post_fact: challenge_id,statement,evidence",
    "request_assistance: challenge_id,expected_revision,reason;[additional_workers,intent_ids,blocker_fact_id]",
    "reject_review: challenge_id,expected_revision,review_revision,reason",
    "arena_start: challenge_id",
    "arena_reconcile: {}",
    "arena_prepare_offline: {}",
    "arena_files: challenge_id;[path] optional",
    "submit_flag: challenge_id,candidate_id,review_revision",
    "reconcile_submissions: {}",
    "defer_challenge: challenge_id,reason,expected_revision;[close_environment] optional",
    "resume_challenge: challenge_id,expected_revision",
    "resources: {}",
    "grow_workers: target_total,reason",
    "finish_attempt: reason",
  ]) assert.ok(prompt.includes(action), action);
  assert.match(prompt, /TOOL-MANIFEST/);
});

test("Worker prompt explains permanent disputes and self-directed judgement", () => {
  const prompt = rolePrompt({
    role: "worker",
    agentId: "worker-1",
    cwd: "/workspace/ctf-run/work/worker-1",
    toolSummary: "TOOL-MANIFEST",
  });
  assert.match(prompt, /disputes 指向目标/);
  assert.match(prompt, /争议永久保留/);
  assert.match(prompt, /平台不会自动恢复、裁决、关闭或改派目标/);
  assert.match(prompt, /post_intent: challenge_id,statement,based_on,expected,method;\[claim,parallel,parallel_key,depends_on,retry_of,relates_to,disputes\]/);
  assert.match(prompt, /each next Intent may include disputes:\[intent_id\]/);
});

test("Worker prompt defines selection, evidence, tools and review without subagents", () => {
  const prompt = rolePrompt({
    role: "worker",
    agentId: "worker-7",
    cwd: "/workspace/ctf-run/work/worker-7",
    toolSummary: "TOOL-MANIFEST",
  });
  assert.match(prompt, /首次工作由平台直接分配/);
  assert.match(prompt, /needs_task_read=false 时直接查看题面和 inputs 并开始执行/);
  assert.doesNotMatch(prompt, /收到 assignment 后直接开始/);
  assert.match(prompt, /任何 new_challenges 都先于 assistance/);
  assert.match(prompt, /available 非空时，本轮必须实际认领一份工作/);
  assert.match(prompt, /不能空等、拒绝认领或把选择留到以后/);
  assert.match(prompt, /竞争失败就读取最新 available 再选/);
  assert.match(prompt, /priority 相同时再综合预期得分、剩余时间、当前上下文和工具惯性选择/);
  assert.match(prompt, /Board 只统一按 priority 排序/);
  assert.match(prompt, /不要在客户端另造离线硬门禁/);
  assert.match(prompt, /困难题被平台放入 assembling 时不要空等援助/);
  assert.match(prompt, /平台先分配 1 个主 Worker，只有没有新题且存在空闲 Worker 或 Lead 增员时，才加入援助 Worker/);
  assert.match(prompt, /正常写 Fact、Intent、认领方向或提交有证据的候选/);
  assert.match(prompt, /只写理由不能扩员/);
  assert.match(prompt, /并行 Intent，平台会在没有新题且有 Worker 时自动开援/);
  assert.match(prompt, /再调用 request_assistance 并传 blocker_fact_id/);
  assert.match(prompt, /unknown 先 reconcile/);
  assert.match(prompt, /官方进度未变化时，按工具说明可安全重试同一候选/);
  assert.match(prompt, /不带 view 的完整读取只用于恢复或状态冲突/);
  assert.match(prompt, /平台会发送一次普通提醒/);
  assert.match(prompt, /文件路径、入口、服务响应、常量、明确失败结论或最小 blocker/);
  assert.match(prompt, /next_intents 发布 1–3 个方向/);
  assert.match(prompt, /援助 assignment 不会预先指定方向/);
  assert.match(prompt, /claimed Intent 属于其他 Worker/);
  assert.match(prompt, /先用 Intent 和稳定的 parallel_key 声明计算目标和关键参数/);
  assert.match(prompt, /compute:<topic> 与 verify:<topic>:independent/);
  assert.match(prompt, /每个 bash 调用结束时会终止该调用启动的整个进程组/);
  assert.match(prompt, /bash 启动的后台进程会随该次调用结束而终止/);
  assert.match(prompt, /修改共享网络、服务、隧道或监听器前/);
  assert.match(prompt, /先写 Fact 记录范围、参数、影响和清理方式/);
  assert.match(prompt, /完成后写结果 Fact/);
  assert.match(prompt, /paths\.worker_cwd/);
  assert.match(prompt, /任务通知中的 paths 覆盖会话默认 cwd/);
  assert.match(prompt, /只并行相互独立的只读操作/);
  assert.match(prompt, /下一次写入前使用最新版本/);
  assert.match(prompt, /board_act claim/);
  assert.match(prompt, /snapshot_file 记录，path 必须用绝对路径/);
  assert.match(prompt, /request_deferral/);
  for (const action of [
    "claim: challenge_id,expected_claim_revision",
    "post_fact: challenge_id,statement,evidence",
    "post_intent: challenge_id,statement,based_on,expected,method",
    "claim_intent: challenge_id,intent_id,expected_version",
    "release_intent: challenge_id,intent_id,note",
    "request_assistance: challenge_id,expected_revision,reason;[additional_workers,intent_ids,blocker_fact_id]",
    "request_deferral: challenge_id,expected_revision,reason",
    "submit_review: challenge_id,expected_revision,flag,summary",
  ]) assert.ok(prompt.includes(action), action);
  assert.match(prompt, /parallel=true requires parallel_key/);
  assert.match(prompt, /不要创建子 Agent 或 helper/);
  assert.match(prompt, /TOOL-MANIFEST/);
});
