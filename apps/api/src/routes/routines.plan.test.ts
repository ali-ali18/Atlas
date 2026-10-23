import assert from "node:assert/strict";
import { test } from "node:test";
process.env.ATLAS_OWNER_EMAIL ||= "owner@example.com";
process.env.BETTER_AUTH_SECRET ||=
	"test-secret-long-enough-for-better-auth-middleware";
const { parseCreateBody, parseUpdateBody } = await import("./routines.js");
test("opt-in de assinatura aceita apenas booleano explícito", () => {
	const body = {
		name: "Task",
		prompt: "Read",
		enabled: false,
		triggerType: "cron",
		schedule: null,
	};
	const defaults = parseCreateBody("bot", body);
	assert.ok(!("error" in defaults));
	assert.equal(defaults.allowChatgptPlan, false);
	const opted = parseCreateBody("bot", { ...body, allowChatgptPlan: true });
	assert.ok(!("error" in opted));
	assert.equal(opted.allowChatgptPlan, true);
	assert.ok(
		"error" in parseCreateBody("bot", { ...body, allowChatgptPlan: "true" })
	);
	assert.deepEqual(parseUpdateBody({ allowChatgptPlan: true }), {
		allowChatgptPlan: true,
	});
	assert.ok("error" in parseUpdateBody({ allowChatgptPlan: 1 }));
});

test("B recebe 404 ao criar ou alterar opt-in de rotina do bot de A", async()=>{
 const {prisma}=await import("@workspace/db");
 const {Hono}=await import("hono");
 const {createRoutineRoutes}=await import("./routines.js");
 const botFind=prisma.bot.findFirst,routineFind=prisma.routine.findFirst;
 Reflect.set(prisma.bot,"findFirst",async({where}: {where:Record<string,unknown>})=>{assert.equal(where.ownerId,"b");return null;});
 Reflect.set(prisma.routine,"findFirst",async()=>null);
 const app=new Hono<import("../middleware/auth.js").AuthEnv>();
 app.use("*",async(c,next)=>{c.set("session",{user:{id:"b"}} as import("../middleware/auth.js").AuthEnv["Variables"]["session"]);await next();});
 app.route("/",createRoutineRoutes(null));
 try {
  const create=await app.request("/v1/bots/bot-a/routines",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"Task",prompt:"Read",enabled:false,triggerType:"cron",schedule:null,allowChatgptPlan:true})});
  assert.equal(create.status,404);
  const update=await app.request("/v1/bots/bot-a/routines/routine-a",{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({allowChatgptPlan:true})});
  assert.equal(update.status,404);
 } finally {prisma.bot.findFirst=botFind;prisma.routine.findFirst=routineFind;}
});

test("gatilho de e-mail: create valida os filtros e update aceita patch (null remove)", () => {
	const base = { name: "NF", prompt: "registre" };
	const created = parseCreateBody("bot", { ...base, trigger: { kind: "email", fromContains: " fornecedor@x.com ", subjectContains: "NF" } });
	assert.ok(!("error" in created));
	assert.equal(created.triggerType, "event");
	assert.deepEqual(created.trigger, { kind: "email", fromContains: "fornecedor@x.com", subjectContains: "NF" });
	assert.deepEqual((parseCreateBody("bot", { ...base, trigger: { kind: "email" } }) as { trigger: unknown }).trigger, { kind: "email" });
	assert.ok("error" in parseCreateBody("bot", { ...base, trigger: { kind: "email", subjectContains: "x".repeat(500) } }));
	assert.ok("error" in parseCreateBody("bot", { ...base, trigger: { kind: "email", fromContains: 7 } }));
	assert.deepEqual(parseUpdateBody({ emailTrigger: { fromContains: null, subjectContains: " boleto " } }), {
		emailTrigger: { fromContains: null, subjectContains: "boleto" },
	});
	assert.ok("error" in parseUpdateBody({ emailTrigger: { subjectContains: 3 } }));
});
