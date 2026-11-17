import { afterEach, describe, expect, it, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentJobService, AgentManager } from "@tokenring-ai/agent";
import type Agent from "@tokenring-ai/agent/Agent";
import { AgentJobsConfigSchema } from "@tokenring-ai/agent/schema";
import createTestingAgent from "@tokenring-ai/agent/test/createTestingAgent.test";
import type TokenRingApp from "@tokenring-ai/app";
import createTestingApp from "@tokenring-ai/app/test/createTestingApp.test";
import ChatService from "@tokenring-ai/chat/ChatService";
import PermissionService, { MemoryPermissionStore } from "@tokenring-ai/chat/PermissionService";
import { permissionSlug } from "@tokenring-ai/chat/permissions/permissionIds";
import { ChatAgentConfigSchema, type ParsedChatConfig } from "@tokenring-ai/chat/schema";
import SchedulerService from "@tokenring-ai/scheduler/SchedulerService";
import { SchedulerConfigSchema } from "@tokenring-ai/scheduler/schema";
import createPost from "../tools/createPost.ts";
import schedulePost from "../tools/schedulePost.ts";
import tools from "../tools.ts";
import XService from "../XService.ts";

const HOUR = 3_600_000;
const future = () => new Date(Date.now() + HOUR).toISOString();

function fakeAgent({ approve = true, account = "brand", maxMessageLength = 280 } = {}) {
  const checkToolApproval = mock(async (_options: { safetyLevel: number; permission?: { id: string; summary: string } }) => approve);
  const x = {
    resolveAccountName: (name?: string) => {
      if (name && name !== account) throw new Error(`X account "${name}" is not connected`);
      return account;
    },
    getProvider: () => ({ maxMessageLength }),
    createPost: mock(async () => ({ id: "1" })),
  };
  const addSchedule = mock((_name: string, _definition: unknown) => ({}));
  const agent = {
    config: { agentType: "social" },
    requireService: (service: unknown) =>
      service === ChatService ? { checkToolApproval } : service === XService ? x : service === SchedulerService ? { addSchedule } : undefined,
    infoMessage: () => {},
  } as unknown as Agent;
  return { agent, checkToolApproval, x, addSchedule };
}

describe("x_schedulePost", () => {
  it("is registered next to x_createPost", () => {
    expect(tools.map(tool => tool.name)).toEqual(["x_createPost", "x_schedulePost"]);
  });

  it("shares x_createPost's permission id, summary and level, so one grant covers scheduling and the later run", async () => {
    const now = fakeAgent({ account: "My Brand.Co" });
    await createPost.execute(createPost.inputSchema.parse({ text: "hello" }), now.agent);
    const later = fakeAgent({ account: "My Brand.Co" });
    await schedulePost.execute(schedulePost.inputSchema.parse({ text: "hello", at: future() }), later.agent);
    const immediate = now.checkToolApproval.mock.calls[0]![0];
    const scheduled = later.checkToolApproval.mock.calls[0]![0];
    expect(scheduled.permission).toEqual({ id: `x.${permissionSlug("My Brand.Co")}.post`, summary: "Post on X as My Brand.Co" });
    expect(scheduled.permission).toEqual(immediate.permission);
    expect(scheduled.safetyLevel).toBe(8);
    expect(scheduled.safetyLevel).toBe(immediate.safetyLevel);
  });

  it("stores a social-x-<id> tool schedule at that instant whose input is exactly x_createPost's input", async () => {
    const { agent, addSchedule } = fakeAgent();
    const at = new Date(Date.now() + HOUR);
    const offset = at.toISOString().replace("Z", "+00:00");
    await schedulePost.execute(schedulePost.inputSchema.parse({ text: "  Hello  ", at: offset, replyToTweetId: "77" }), agent);
    expect(addSchedule).toHaveBeenCalledTimes(1);
    const [name, definition] = addSchedule.mock.calls[0]!;
    expect(name).toMatch(/^social-x-[0-9a-f]{8}$/);
    expect(definition).toEqual({
      at: at.toISOString(),
      action: { kind: "tool", agentType: "social", tool: "x_createPost", input: { text: "Hello", account: "brand", replyToTweetId: "77" } },
    });
    // The stored input is something x_createPost accepts as is.
    expect(createPost.inputSchema.safeParse((definition as { action: { input: unknown } }).action.input).success).toBe(true);
  });

  it("schedules nothing when declined", async () => {
    const { agent, addSchedule } = fakeAgent({ approve: false });
    await expect(schedulePost.execute(schedulePost.inputSchema.parse({ text: "hi", at: future() }), agent)).rejects.toThrow(/did not approve/);
    expect(addSchedule).not.toHaveBeenCalled();
  });

  it("refuses a time in the past, a time without an offset, and an unparseable one, before asking anyone", async () => {
    const { agent, checkToolApproval, addSchedule } = fakeAgent();
    const run = (at: string) => schedulePost.execute(schedulePost.inputSchema.parse({ text: "hi", at }), agent);
    await expect(run(new Date(Date.now() - HOUR).toISOString())).rejects.toThrow(/must be in the future/);
    await expect(run("2099-01-01T09:00:00")).rejects.toThrow(/UTC offset/);
    await expect(run("next tuesday")).rejects.toThrow(/UTC offset/);
    expect(checkToolApproval).not.toHaveBeenCalled();
    expect(addSchedule).not.toHaveBeenCalled();
  });

  it("refuses an unknown account and text over the account's limit, before asking anyone", async () => {
    const unknown = fakeAgent();
    await expect(schedulePost.execute(schedulePost.inputSchema.parse({ text: "hi", at: future(), account: "ghost" }), unknown.agent)).rejects.toThrow(
      /"ghost" is not connected/,
    );
    const tooLong = fakeAgent({ maxMessageLength: 5 });
    await expect(schedulePost.execute(schedulePost.inputSchema.parse({ text: "far too long", at: future() }), tooLong.agent)).rejects.toThrow(
      /account limit of 5/,
    );
    for (const { checkToolApproval, addSchedule } of [unknown, tooLong]) {
      expect(checkToolApproval).not.toHaveBeenCalled();
      expect(addSchedule).not.toHaveBeenCalled();
    }
  });
});

describe("a scheduled X post, end to end (X client stubbed)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  async function boot() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x-scheduled-"));
    dirs.push(dir);
    const app = createTestingApp() as TokenRingApp;
    const starter = createTestingAgent(app);
    const withChat = { ...starter.config, chat: ChatAgentConfigSchema.parse({ systemPrompt: "test" }) };
    app.requireService(AgentManager).addAgentConfigs(withChat);

    const chat = app.addService(ChatService, new ChatService(app));
    // The person scheduling (the starter agent) can approve level 8; an unattended job approves at most level 3.
    chat.getChatConfig = (agent: Agent) => ({ autoToolApprovalLevel: agent.id === starter.id ? 8 : 3, toolApprovalMode: "ask" }) as ParsedChatConfig;
    chat.updateChatConfig = () => {};
    chat.addTools(tools);
    const permissions = app.addService(PermissionService, new PermissionService(app, new MemoryPermissionStore()));

    const createdPosts: { text: string; account: string | undefined; replyToTweetId: string | undefined }[] = [];
    const x = {
      resolveAccountName: (name?: string) => name ?? "brand",
      getProvider: () => ({ maxMessageLength: 280 }),
      async createPost(text: string, options: { account?: string; replyToTweetId?: string } = {}) {
        createdPosts.push({ text, account: options.account, replyToTweetId: options.replyToTweetId });
        return { id: "555", account: options.account ?? "brand" };
      },
    };
    app.addService(XService, x as unknown as XService);

    const jobs = app.addService(
      AgentJobService,
      new AgentJobService(app, { recordsFile: path.join(dir, "jobs.json"), config: AgentJobsConfigSchema.parse({}) }),
    );
    jobs.setChatIntegration(chat.jobIntegration());
    const scheduler = app.addService(SchedulerService, new SchedulerService(app, { storeFile: path.join(dir, "schedules.json") }));
    scheduler.reconfigure(SchedulerConfigSchema.parse({}));
    scheduler.load();
    const controller = new AbortController();
    scheduler.start(controller.signal);
    return {
      starter,
      permissions,
      jobs,
      scheduler,
      createdPosts,
      stop: async () => {
        controller.abort();
        jobs.stop();
        await jobs.flush();
        await scheduler.flush();
      },
    };
  }

  async function waitFor(condition: () => boolean, timeoutMs = 3000) {
    const start = Date.now();
    while (!condition()) {
      if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting");
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }

  /** Schedules through the real tool, 150 ms out, and waits for the unattended run to end. */
  async function scheduleAndWait(ctx: Awaited<ReturnType<typeof boot>>) {
    const at = new Date(Date.now() + 150).toISOString();
    await schedulePost.execute(schedulePost.inputSchema.parse({ text: "Launch day", at }), ctx.starter);
    const [name] = ctx.scheduler.listSchedules().map(view => view.name);
    expect(name).toMatch(/^social-x-/);
    expect(ctx.createdPosts).toEqual([]); // nothing goes out at schedule time
    await waitFor(() => (ctx.scheduler.getHistory(name!)[name!] ?? []).some(run => run.status !== "running"));
    return { name: name!, run: ctx.scheduler.getHistory(name!)[name!]!.at(-1)! };
  }

  it("with no grant the fired schedule is refused, records the refusal with the permission id, and posts nothing", async () => {
    const ctx = await boot();
    try {
      const { run } = await scheduleAndWait(ctx);
      expect(ctx.createdPosts).toEqual([]);
      expect(run.status).toBe("failed");
      expect(run.message).toContain("x.brand.post");
      const job = ctx.jobs.get(run.jobId!)!;
      expect(job.refusalCount).toBe(1);
      expect(job.refusals[0]).toMatchObject({ tool: "x_createPost", level: 8, permissionId: "x.brand.post", permissionSummary: "Post on X as brand" });
    } finally {
      await ctx.stop();
    }
  });

  it("with the grant the fired schedule posts the exact text once, with the same account", async () => {
    const ctx = await boot();
    try {
      await ctx.permissions.grant({ id: "x.brand.post", summary: "Post on X as brand" });
      const { name, run } = await scheduleAndWait(ctx);
      expect(run.status).toBe("completed");
      expect(ctx.createdPosts).toEqual([{ text: "Launch day", account: "brand", replyToTweetId: undefined }]);
      expect(ctx.jobs.get(run.jobId!)).toMatchObject({ status: "succeeded", refusalCount: 0 });
      expect(ctx.permissions.list().find(grant => grant.id === "x.brand.post")?.uses).toBe(2); // once to schedule... and once to post
      expect(ctx.scheduler.getSchedule(name)).toMatchObject({ enabled: false, nextRunTime: null });
    } finally {
      await ctx.stop();
    }
  });
});
