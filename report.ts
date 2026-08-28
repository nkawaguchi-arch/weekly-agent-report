/**
 * weekly-agent-report / report.ts
 * ---------------------------------------------------------------------------
 * Notion Admin API から「カスタムエージェントの週次稼働・クレジットレポート」を
 * 生成する参考スクリプト（1ファイル完結）。
 *
 * ■ このスクリプトがやること
 *   1. GET /admin/v1/spaces/{space}/agents               … 稼働状態 / モデル / 連携 / 共有先グループ(部署) / 担当ID
 *   2. GET /admin/v1/spaces/{space}/agents/credit_usage  … 消費クレジット / 実行回数 / クレジット上限
 *   3. 2つを agent.id で結合し、担当ID→氏名・グループID→部署名 を変換
 *   4. コンソールに表を出力 ＆ report.json を書き出し
 *   5. （任意）Notion DB へ upsert … 「効果」列は手入力を守るため上書きしない
 *
 * ■ 前提
 *   - Node.js >= 22（グローバル fetch を使用、追加依存なし）
 *   - 実行:  npx tsx report.ts
 *
 * ■ 必要な権限
 *   - 組織 bot トークンに scope: workflows:read
 *   - Admin API バージョン: 2026-06-01
 *
 * ※ これは「技術者に渡す参考実装」です。担当ID/グループID の名前解決や
 *    Notion 書き込みは環境に合わせて調整してください（該当箇所に NOTE を記載）。
 * ---------------------------------------------------------------------------
 */

// ===========================================================================
// 設定（環境変数）
// ===========================================================================

/** 環境変数を必須で取得。無ければ分かりやすく落とす。 */
function requireEnv(key: string): string {
	const v = process.env[key];
	if (!v) {
		console.error(`✗ 環境変数 ${key} が未設定です。.env を確認してください（.env.example 参照）。`);
		process.exit(1);
	}
	return v;
}

const CONFIG = {
	/** 組織 bot トークン（workflows:read scope 必須）。全員に配らないこと。 */
	adminToken: requireEnv("NOTION_ADMIN_TOKEN"),
	/** 対象スペース（ワークスペース）の UUID。 */
	spaceId: requireEnv("SPACE_ID"),
	/** Admin API バージョン。現状 2026-06-01 固定。 */
	notionVersion: process.env.NOTION_VERSION ?? "2026-06-01",
	/** Admin API のベース URL。 */
	adminBase: "https://api.notion.com/admin/v1",

	/**
	 * 担当ID→氏名 変換に使う「通常の Notion API」トークン（任意）。
	 * 未設定なら担当は ID のまま表示する。
	 * NOTE: Admin API には「ユーザー一覧」エンドポイントが無いため、
	 *       氏名解決は通常の Notion API GET /v1/users/{id} を使う。
	 */
	notionApiToken: process.env.NOTION_API_TOKEN ?? "",

	/**
	 * （現在は未使用）集計期間は「今週の月〜日」に固定しています（currentCalendarWeek）。
	 * ローリング7日集計に戻したい場合のフックとして env は残しています。
	 */
	windowDays: Number(process.env.WINDOW_DAYS ?? "7"),

	/** （任意）出力先 Notion DB（1行＝1エージェントの詳細）。設定時のみ upsert する。 */
	outputDatabaseId: process.env.OUTPUT_DATABASE_ID ?? "",

	/**
	 * （任意）週次ログ DB（1行＝1週間のサマリー）。設定時のみ 1 行 append/upsert する。
	 * このDBの database_id を指定（例: 00000000000000000000000000000000）。
	 */
	weeklyLogDatabaseId: process.env.WEEKLY_LOG_DATABASE_ID ?? "",

	/**
	 * （任意）月次累積ログ DB（1行＝1ヶ月・1月起点の累積クレジット）。設定時のみ当月行を upsert する。
	 */
	monthlyLogDatabaseId: process.env.MONTHLY_LOG_DATABASE_ID ?? "",

	/**
	 * （任意）日次クレジットログ DB（1行＝1エージェント×1日）。設定時のみ「今日の行」を各エージェントで upsert。
	 * 各エージェントの日次消費の推移グラフの元データ。
	 */
	dailyLogDatabaseId: process.env.DAILY_LOG_DATABASE_ID ?? "",

	/**
	 * （任意）部署マスタ（People DB）。作成者ID → 部署 の対応表として使う。
	 * DEPT_DB_TOKEN … その DB を読めるトークン（別ワークスペースなら、その WS のトークン）。
	 * DEPT_DB_ID … People DB の ID。
	 * People DB 側は「Person（people 型）」と「部署（select/text）」列を持つ想定。
	 */
	deptDbToken: process.env.DEPT_DB_TOKEN ?? "",
	deptDbId: (process.env.DEPT_DB_ID ?? "").replace(/-/g, ""),

	/**
	 * クレジット上限の「書き戻し」を有効化するフラグ（既定 OFF）。
	 * true のとき、詳細DBの「希望クレジット上限」を Admin API で実際のエージェントに反映する。
	 * ★ 実際の本番設定を変更する高影響機能。Admin token に workflows:write が必要。
	 */
	enableCreditWriteback: process.env.ENABLE_CREDIT_LIMIT_WRITEBACK === "true",

	/**
	 * 稼働状態の「書き戻し」を有効化するフラグ（既定 OFF）。
	 * true のとき、詳細DBの「稼働状態」を 稼働中↔停止中 に変えると Admin API で実際に停止/再開する。
	 * ★ 実際の本番エージェントを停止/再開する高影響機能。Admin token に workflows:write が必要。
	 */
	enableStatusWriteback: process.env.ENABLE_STATUS_WRITEBACK === "true",
};

// ===========================================================================
// 型定義（レスポンスは必要なフィールドのみ記述）
// ===========================================================================

/** GET /agents の 1 件。 */
type Agent = {
	id: string;
	name: string;
	description?: string;
	type?: string; // custom / database など
	status?: string; // active / credit_limit / disabled... （実フィールド。alive より正確）
	icon?: string;
	alive: boolean;
	created_by_id?: string;
	created_time?: number; // epoch ms
	last_edited_time?: number; // epoch ms
	last_run_time?: number; // epoch ms
	moved_to_trash_time?: number; // epoch ms（削除済みなら値あり）
	modules?: Array<{
		type?: string; // notion / slack / mcpServer など
		name?: string;
		version?: string;
		scopes?: string[];
		resources?: Array<{ kind?: string; ids?: string[]; actions?: string[] }>;
	}>;
	permissions?: Array<{
		principal?: { type?: string; user_id?: string; group_id?: string };
		role?: string;
	}>;
};

/** GET /agents/credit_usage の 1 件。 */
type CreditUsage = {
	id: string;
	name?: string;
	total_credits_used?: number;
	runs_completed?: number;
	credit_limit?: number;
	last_credit_usage_time?: number; // epoch ms
	created_by_id?: string;
};

/** レポート 1 行（表示用に整形済み）。 */
type ReportRow = {
	id: string; // エージェントの一意 ID（upsert のキー）
	name: string;
	status: string; // 稼働中 / 上限到達 / 停止中 / 削除済み
	creditsUsed: number;
	prevCreditsUsed: number; // 前日23:59までの累積消費クレジット（1月起点）※日次ログの当日消費計算に使う
	prevDayDaily: number; // 前日"単日"の消費（前日末累積 − 前々日末累積）
	todayDaily: number; // 当日"単日"の消費（累計 − 前日末累積）
	creditLimit: number | null;
	runs: number;
	lastRun: string; // YYYY/MM/DD（表示用）
	lastRunIso: string | null; // YYYY-MM-DD（Notion date プロパティ用）
	owner: string; // 氏名 or ID
	department: string; // 部署名 or グループID
	connectors: string; // 連携ツール要約 "Slack, Notion, Figma"
	description: string; // 説明
	agentType: string; // custom など
	sharing: string; // 共有の要約 "1件 (full_access)"
	permissionsText: string; // 権限（共有先を氏名＋ロールで列挙）
	createdIso: string | null; // 作成日時
	lastEditedIso: string | null; // 最終編集
	settingsBody: string; // 設定詳細（連携ツール・スコープ・共有の全文）
	// effect（効果）は API に無い列。手入力なのでここでは埋めない。
};

// ===========================================================================
// Admin API クライアント
// ===========================================================================

/** Admin API に GET。エラー時は本文付きで投げる。 */
async function adminGet(path: string, query: Record<string, string> = {}): Promise<any> {
	const url = new URL(`${CONFIG.adminBase}${path}`);
	for (const [k, v] of Object.entries(query)) {
		if (v !== undefined && v !== "") url.searchParams.set(k, v);
	}
	const res = await fetch(url, {
		headers: {
			Authorization: `Bearer ${CONFIG.adminToken}`,
			"Notion-Version": CONFIG.notionVersion,
		},
	});
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Admin API ${res.status} ${res.statusText} @ ${path}\n${body}`);
	}
	return res.json();
}

/** Admin API に PATCH（書き込み）。失敗時は本文付きで投げる。workflows:write が必要。 */
async function adminPatch(path: string, body: unknown): Promise<any> {
	const res = await fetch(`${CONFIG.adminBase}${path}`, {
		method: "PATCH",
		headers: {
			Authorization: `Bearer ${CONFIG.adminToken}`,
			"Notion-Version": CONFIG.notionVersion,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const t = await res.text();
		throw new Error(`Admin API ${res.status} ${res.statusText} @ PATCH ${path}\n${t}`);
	}
	return res.json();
}

/** Admin API に PUT（書き込み）。失敗時は本文付きで投げる。workflows:write が必要。 */
async function adminPut(path: string, body: unknown): Promise<any> {
	const res = await fetch(`${CONFIG.adminBase}${path}`, {
		method: "PUT",
		headers: {
			Authorization: `Bearer ${CONFIG.adminToken}`,
			"Notion-Version": CONFIG.notionVersion,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const t = await res.text();
		throw new Error(`Admin API ${res.status} ${res.statusText} @ PUT ${path}\n${t}`);
	}
	return res.json();
}

/**
 * cursor ページングを最後まで辿って results を全部集める共通ヘルパ。
 * Admin API は { has_more, results[], next_cursor } の形。
 */
async function fetchAllPages<T>(path: string, query: Record<string, string> = {}): Promise<T[]> {
	const all: T[] = [];
	let cursor: string | undefined;
	do {
		const page = await adminGet(path, { ...query, ...(cursor ? { cursor } : {}) });
		all.push(...(page.results ?? []));
		cursor = page.has_more ? page.next_cursor : undefined;
	} while (cursor);
	return all;
}

/** エージェント一覧（稼働状態・共有先グループ・担当ID など）。 */
function fetchAgents(): Promise<Agent[]> {
	return fetchAllPages<Agent>(`/spaces/${CONFIG.spaceId}/agents`, { page_size: "100" });
}

/** 期間内のクレジット使用量（総量・実行回数・上限）。 */
function fetchCreditUsage(fromMs: number, toMs: number): Promise<CreditUsage[]> {
	return fetchAllPages<CreditUsage>(`/spaces/${CONFIG.spaceId}/agents/credit_usage`, {
		page_size: "100",
		credit_usage_time_from: String(fromMs),
		credit_usage_time_to: String(toMs),
	});
}

// ===========================================================================
// 名前解決（担当ID→氏名 / グループID→部署名）
// ===========================================================================

/**
 * 担当ID→氏名。通常の Notion API を使う（Admin API にユーザー一覧が無いため）。
 * NOTE: NOTION_API_TOKEN 未設定、または取得失敗時は ID の先頭8文字を返す。
 */
const userNameCache = new Map<string, string>();
async function resolveUserName(userId: string | undefined): Promise<string> {
	if (!userId) return "—";
	if (userNameCache.has(userId)) return userNameCache.get(userId)!;
	let display = userId.slice(0, 8) + "…"; // フォールバック（ID表示）
	if (CONFIG.notionApiToken) {
		try {
			const res = await fetch(`https://api.notion.com/v1/users/${userId}`, {
				headers: {
					Authorization: `Bearer ${CONFIG.notionApiToken}`,
					"Notion-Version": "2022-06-28",
				},
			});
			if (res.ok) {
				const u = (await res.json()) as { name?: string };
				display = u.name ?? display;
			}
		} catch {
			/* フォールバックのまま */
		}
	}
	userNameCache.set(userId, display);
	return display;
}

/**
 * グループID→部署名。
 * NOTE: 共有先グループ(permissions) はグループ ID で返る。ID→部署名の
 *       公開エンドポイントは無いので、departments.json に対応表を持つ。
 *       未定義のグループ ID はそのまま表示する（対応表に追記していく運用）。
 */
let departmentMap: Record<string, string> = {};
async function loadDepartmentMap(): Promise<void> {
	try {
		const fs = await import("node:fs/promises");
		const raw = await fs.readFile(new URL("./departments.json", import.meta.url), "utf-8");
		departmentMap = JSON.parse(raw);
	} catch {
		departmentMap = {}; // 無ければ空でOK（ID表示になる）
	}
}
function resolveDepartments(agent: Agent): string {
	const groupIds = (agent.permissions ?? [])
		.map((p) => p.principal?.group_id)
		.filter((g): g is string => Boolean(g));
	if (groupIds.length === 0) return "—";
	const names = groupIds.map((id) => departmentMap[id] ?? id.slice(0, 8) + "…");
	return Array.from(new Set(names)).join(", ");
}

/**
 * 作成者ID → 部署 の対応表を People DB（部署マスタ）から読み込む。
 * People DB の「Person（people型）」列のユーザーIDをキー、「部署」列をバリューにする。
 * DEPT_DB_TOKEN / DEPT_DB_ID 未設定なら空マップ（部署は "—" のまま）。
 */
const creatorDeptMap = new Map<string, string>();
async function loadCreatorDepartmentMap(): Promise<void> {
	creatorDeptMap.clear();
	if (!CONFIG.deptDbToken || !CONFIG.deptDbId) return;
	const headers = {
		Authorization: `Bearer ${CONFIG.deptDbToken}`,
		"Notion-Version": "2022-06-28",
		"Content-Type": "application/json",
	};
	const pick = (v: any): string => {
		if (!v) return "";
		if (v.type === "select") return v.select?.name ?? "";
		if (v.type === "multi_select") return (v.multi_select ?? []).map((s: any) => s.name).join(", ");
		if (v.type === "rich_text") return (v.rich_text ?? []).map((t: any) => t.plain_text).join("");
		return "";
	};
	let cursor: string | undefined;
	try {
		do {
			const res = await fetch(`https://api.notion.com/v1/databases/${CONFIG.deptDbId}/query`, {
				method: "POST",
				headers,
				body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
			});
			if (!res.ok) {
				console.warn(`△ 部署DBの読み取りに失敗（${res.status}）。部署は空のままにします。`);
				return;
			}
			const data = (await res.json()) as any;
			for (const row of data.results ?? []) {
				const props = row.properties ?? {};
				const deptKey = Object.keys(props).find((k) => /部署|department|team|チーム/i.test(k));
				const dept = deptKey ? pick(props[deptKey]) : "";
				if (!dept) continue;
				const personKey = Object.keys(props).find((k) => props[k]?.type === "people");
				const people = personKey ? (props[personKey]?.people ?? []) : [];
				for (const p of people) {
					if (p?.id) creatorDeptMap.set(p.id, dept);
				}
			}
			cursor = data.has_more ? data.next_cursor : undefined;
		} while (cursor);
		console.log(`  部署マスタ読み込み: ${creatorDeptMap.size} 人分の部署を取得。`);
	} catch {
		/* フォールバック（空マップ） */
	}
}

// ===========================================================================
// 整形
// ===========================================================================

/** epoch ms → "YYYY/MM/DD"。未設定は "—"。 */
function fmtDate(ms: number | undefined): string {
	if (!ms) return "—";
	const d = new Date(ms);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
}

/** epoch ms → "YYYY-MM-DD"（ローカル時刻）。Notion date プロパティ用（UTC変換で日付がズレないように）。 */
function isoDateLocal(ms: number): string {
	const d = new Date(ms);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 今週（カレンダー週）の範囲を返す。週の開始は月曜、終了は日曜。
 * 30分ごとに実行しても、同じ週の間は from/to が変わらない → 週次ログの行が増えない。
 */
function currentCalendarWeek(nowMs: number): { fromMs: number; toMs: number } {
	const d = new Date(nowMs);
	const day = d.getDay(); // 0=日, 1=月, ... 6=土
	const daysSinceMonday = (day + 6) % 7; // 月曜からの経過日数
	const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysSinceMonday, 0, 0, 0, 0);
	const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6, 23, 59, 59, 999);
	return { fromMs: monday.getTime(), toMs: sunday.getTime() };
}

/** Admin API の status 値 → DB の select ラベル（稼働中/上限到達/停止中/削除済み）に丸める。 */
function statusLabel(status: string | undefined): string {
	if (!status) return "稼働中";
	if (status === "deleted") return "削除済み";
	if (status === "active") return "稼働中";
	if (status === "credit_limit" || status === "workspace_credit_limit" || status === "runaway_credit_usage") {
		return "上限到達";
	}
	// disabled 系・needs_review・各種 limit / error はまとめて「停止中」
	return "停止中";
}

/** 稼働状態の判定。実フィールド status を優先し、無ければ alive/trash で補完。 */
function deriveStatus(agent: Agent, usage: CreditUsage | undefined): string {
	if (agent.moved_to_trash_time || agent.status === "deleted") return "削除済み";
	if (agent.status) return statusLabel(agent.status);
	// フォールバック（status 欠落時）
	if (!agent.alive) return "停止中";
	if (usage?.credit_limit && (usage.total_credits_used ?? 0) >= usage.credit_limit) return "上限到達";
	return "稼働中";
}

/** modules → "Slack, Notion, Figma" のような連携ツール要約。 */
function summarizeConnectors(agent: Agent): string {
	const types = (agent.modules ?? [])
		.map((m) => m.name ?? m.type)
		.filter((t): t is string => Boolean(t));
	return types.length ? Array.from(new Set(types)).join(", ") : "—";
}

/** permissions → "1件 (full_access)" のような共有要約。 */
function summarizeSharing(agent: Agent): string {
	const perms = agent.permissions ?? [];
	if (perms.length === 0) return "—";
	const roles = Array.from(new Set(perms.map((p) => p.role ?? "?")));
	return `${perms.length}件 (${roles.join(", ")})`;
}

/** permissions → "田中 太郎 (full_access), 営業グループ (editor)" のように氏名＋ロールで列挙。 */
async function summarizePermissions(agent: Agent): Promise<string> {
	const perms = agent.permissions ?? [];
	if (perms.length === 0) return "—";
	const parts: string[] = [];
	for (const p of perms) {
		let who: string;
		if (p.principal?.user_id) who = await resolveUserName(p.principal.user_id);
		else if (p.principal?.group_id) who = departmentMap[p.principal.group_id] ?? p.principal.group_id.slice(0, 8) + "…";
		else who = p.principal?.type ?? "?";
		parts.push(`${who}${p.role ? " (" + p.role + ")" : ""}`);
	}
	return parts.join(", ");
}

/**
 * 各エージェントの設定を「取りこぼしなく」1つのテキストに整形する（設定詳細プロパティ用）。
 * 連携ツール（種別・スコープ・リソース・アクション）＋共有（ユーザー/グループ・ロール）＋基本情報。
 */
async function buildSettingsText(agent: Agent): Promise<string> {
	const L: string[] = [];
	L.push("■ 基本情報");
	L.push(`  タイプ: ${agent.type ?? "—"} / ステータス: ${agent.status ?? "—"}`);
	if (agent.description) L.push(`  説明: ${agent.description}`);
	L.push(`  作成: ${fmtDate(agent.created_time)} / 最終編集: ${fmtDate(agent.last_edited_time)}`);

	L.push("");
	L.push("■ 連携ツール");
	const mods = agent.modules ?? [];
	if (mods.length === 0) L.push("  （なし）");
	for (const m of mods) {
		const scopes = (m.scopes ?? []).join(", ");
		L.push(`  ● ${m.name ?? m.type ?? "?"}（${m.type ?? "?"}${m.version ? " v" + m.version : ""}）${scopes ? " / スコープ: " + scopes : ""}`);
		for (const res of m.resources ?? []) {
			const target = (res.ids ?? []).join(", ") || res.kind || "—";
			const acts = (res.actions ?? []).join(", ");
			L.push(`      - ${target}${acts ? " → " + acts : ""}`);
		}
	}

	L.push("");
	L.push("■ 共有（権限）");
	const perms = agent.permissions ?? [];
	if (perms.length === 0) L.push("  （なし）");
	for (const p of perms) {
		const kind = p.principal?.type ?? "?";
		let who = "—";
		if (p.principal?.user_id) who = await resolveUserName(p.principal.user_id);
		else if (p.principal?.group_id) who = departmentMap[p.principal.group_id] ?? p.principal.group_id.slice(0, 8) + "…";
		L.push(`  - ${kind}: ${who} — ${p.role ?? "—"}`);
	}
	return L.join("\n");
}

/** Notion rich_text は 1 オブジェクト 2000 文字まで。長文を分割して rich_text 配列にする。 */
function toRichText(text: string): Array<{ text: { content: string } }> {
	const chunks: Array<{ text: { content: string } }> = [];
	let s = text.slice(0, 1900 * 20); // 念のため上限（約38k字）
	while (s.length > 0) {
		chunks.push({ text: { content: s.slice(0, 1900) } });
		s = s.slice(1900);
	}
	return chunks.length ? chunks : [{ text: { content: "" } }];
}

/**
 * エージェント一覧 ＋ クレジット使用量 を結合して行データにする。
 *
 * 前日/当日の単日消費は、日次クレジットログDB自身が記録した過去の累積値（ライブ記録＝信頼できる）
 * を読み返して差分を取る。Admin API に「過去の特定時点の累積」を尋ねる方式は使わない
 * （readDailyLogCumulative のコメント参照：最終利用時刻でエージェントが丸ごと除外される不具合があるため）。
 */
async function buildRows(
	agents: Agent[],
	usage: CreditUsage[],
	prevDayLedger: Map<string, number>,
	twoDaysAgoLedger: Map<string, number>,
): Promise<ReportRow[]> {
	const usageById = new Map(usage.map((u) => [u.id, u]));
	const rows: ReportRow[] = [];
	for (const agent of agents) {
		const u = usageById.get(agent.id);
		const cum = u?.total_credits_used ?? 0; // 累計（今日含む・現在時点のライブ値なので信頼できる）
		// 台帳（日次ログの過去記録）に無ければ「記録開始前」なので不明 → 0扱い（初日は0になる既知の制約）
		const prevCum = prevDayLedger.get(agent.id) ?? 0; // 前日に記録された累積
		const twoDaysAgoCum = twoDaysAgoLedger.get(agent.id) ?? 0; // 前々日に記録された累積
		rows.push({
			id: agent.id,
			name: agent.name,
			status: deriveStatus(agent, u),
			creditsUsed: cum,
			prevCreditsUsed: prevCum,
			prevDayDaily: prevCum - twoDaysAgoCum, // 前日の単日消費
			todayDaily: cum - prevCum, // 当日の単日消費
			creditLimit: u?.credit_limit ?? null,
			runs: u?.runs_completed ?? 0,
			lastRun: fmtDate(agent.last_run_time),
			lastRunIso: agent.last_run_time ? isoDateLocal(agent.last_run_time) : null,
			owner: await resolveUserName(agent.created_by_id ?? u?.created_by_id),
			// 部署は「作成者ID → 部署（People DB）」を優先。無ければ共有先グループ由来にフォールバック。
			department: creatorDeptMap.get(agent.created_by_id ?? "") ?? resolveDepartments(agent),
			connectors: summarizeConnectors(agent),
			description: agent.description ?? "",
			agentType: agent.type ?? "",
			sharing: summarizeSharing(agent),
			permissionsText: await summarizePermissions(agent),
			createdIso: agent.created_time ? isoDateLocal(agent.created_time) : null,
			lastEditedIso: agent.last_edited_time ? isoDateLocal(agent.last_edited_time) : null,
			settingsBody: await buildSettingsText(agent),
		});
	}
	// 消費クレジットの多い順に並べる。
	rows.sort((a, b) => b.creditsUsed - a.creditsUsed);
	return rows;
}

// ===========================================================================
// 出力
// ===========================================================================

/** コンソールに簡易テーブルで出力。 */
function printConsole(rows: ReportRow[], fromMs: number, toMs: number): void {
	console.log(`\n■ カスタムエージェント レポート`);
	console.log(`  今週: ${fmtDate(fromMs)} – ${fmtDate(toMs)} / 対象: ${rows.length} 件`);
	const total = rows.reduce((s, r) => s + r.creditsUsed, 0);
	console.log(`  累計消費クレジット合計: ${total.toLocaleString()} cr（詳細は累計・週次ログは今週分）\n`);

	const header = ["エージェント名", "状態", "クレジット", "実行", "担当", "部署"];
	const table = rows.map((r) => ({
		"エージェント名": r.name,
		"状態": r.status,
		"クレジット": r.creditsUsed.toLocaleString(),
		"実行": r.runs,
		"担当": r.owner,
		"部署": r.department,
	}));
	// console.table は見やすく整形してくれる。
	console.table(table, header);
}

/** report.json を書き出し（他ツールへの受け渡し用）。 */
async function writeJson(rows: ReportRow[], fromMs: number, toMs: number): Promise<void> {
	const fs = await import("node:fs/promises");
	const out = {
		generatedAt: new Date().toISOString(),
		periodFrom: new Date(fromMs).toISOString(),
		periodTo: new Date(toMs).toISOString(),
		totalCreditsUsed: rows.reduce((s, r) => s + r.creditsUsed, 0),
		rows,
	};
	await fs.writeFile(new URL("./report.json", import.meta.url), JSON.stringify(out, null, 2), "utf-8");
	console.log(`\n✓ report.json を書き出しました。`);
}

/** 通常 Notion API の書き込み。失敗時は HTTP ステータスと本文付きで throw する（サイレント失敗を防ぐ）。 */
async function notionWrite(
	url: string,
	method: "POST" | "PATCH",
	body: unknown,
	headers: Record<string, string>,
): Promise<any> {
	const res = await fetch(url, { method, headers, body: JSON.stringify(body) });
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Notion API ${res.status} ${res.statusText} @ ${method} ${url}\n${text}`);
	}
	return res.json();
}

/**
 * （任意）Notion DB へ upsert する場合の参考実装。
 * OUTPUT_DATABASE_ID を設定した時だけ動く。
 *
 * ★ 重要な設計: 「効果」列は手入力なので、既存ページがあっても上書きしない。
 *   → エージェント名で既存ページを検索し、
 *      あれば「効果」以外を更新 / 無ければ新規作成する。
 *
 * NOTE: DB のプロパティ名は README の想定スキーマに合わせています。
 *       実際の DB に合わせてプロパティ名を調整してください。
 */
async function upsertToNotion(rows: ReportRow[]): Promise<void> {
	if (!CONFIG.outputDatabaseId) return;
	if (!CONFIG.notionApiToken) {
		console.warn("△ OUTPUT_DATABASE_ID はあるが NOTION_API_TOKEN が無いため Notion 書き込みをスキップ。");
		return;
	}
	const headers = {
		Authorization: `Bearer ${CONFIG.notionApiToken}`,
		"Notion-Version": "2022-06-28",
		"Content-Type": "application/json",
	};

	for (const r of rows) {
		// 1) エージェントID で既存ページを検索（IDは一意なので、同名エージェントも別行になる）
		const query = await fetch(
			`https://api.notion.com/v1/databases/${CONFIG.outputDatabaseId}/query`,
			{
				method: "POST",
				headers,
				body: JSON.stringify({
					filter: { property: "エージェントID", rich_text: { equals: r.id } },
					page_size: 1,
				}),
			},
		).then((res) => res.json() as Promise<{ results?: Array<{ id: string }> }>);

		// 「効果」列は含めない（手入力を守る）。
		// プロパティ型は実際の Notion DB スキーマに合わせる:
		//   稼働状態=select / 最終実行=date / 部署=select（複数グループなら先頭のみ）
		const hasDept = r.department && r.department !== "—";
		const properties: Record<string, unknown> = {
			"エージェント名": { title: [{ text: { content: r.name } }] },
			"エージェントID": { rich_text: [{ text: { content: r.id } }] },
			"稼働状態": { select: { name: r.status } },
			"消費クレジット": { number: r.creditsUsed },
			"前日の消費クレジット": { number: r.prevDayDaily },
			"当日の消費クレジット": { number: r.todayDaily },
			"クレジット上限": r.creditLimit != null ? { number: r.creditLimit } : { number: null },
			"権限": { rich_text: toRichText(r.permissionsText) },
			"実行回数": { number: r.runs },
			"最終実行": r.lastRunIso ? { date: { start: r.lastRunIso } } : { date: null },
			"作成者": { rich_text: [{ text: { content: r.owner } }] },
			// --- エージェント設定 ---
			"説明": { rich_text: toRichText(r.description) },
			"連携ツール": { rich_text: toRichText(r.connectors) },
			"タイプ": r.agentType ? { select: { name: r.agentType } } : { select: null },
			"共有": { rich_text: toRichText(r.sharing) },
			"作成日時": r.createdIso ? { date: { start: r.createdIso } } : { date: null },
			"最終編集": r.lastEditedIso ? { date: { start: r.lastEditedIso } } : { date: null },
			"設定詳細": { rich_text: toRichText(r.settingsBody) },
		};
		// 部署は「値が取れた時だけ」書く。取れない時はプロパティ自体を省略し、既存値を上書き（消去）しない。
		// → 部署マスタ未読込（DEPT_DB_TOKEN欠落など）でも、既に入っている部署が消えない。
		if (hasDept) properties["部署"] = { select: { name: r.department.split(",")[0].trim() } };

		const existing = query.results?.[0];
		if (existing) {
			// 2a) 既存ページを更新（効果は触らない）
			await notionWrite(`https://api.notion.com/v1/pages/${existing.id}`, "PATCH", { properties }, headers);
		} else {
			// 2b) 新規作成
			await notionWrite(
				`https://api.notion.com/v1/pages`,
				"POST",
				{ parent: { database_id: CONFIG.outputDatabaseId }, properties },
				headers,
			);
		}
	}
	console.log(`✓ Notion DB に ${rows.length} 件を upsert しました（「効果」列は保持）。`);
}

/**
 * （任意）週次ログ DB に「その週の合計」を 1 行 upsert する。
 * 「週」（期間ラベル）をキーに、同じ週があれば更新・無ければ新規作成。
 *
 * ★ 「週次の所感・効果」列は手入力なので、更新時も上書きしない。
 */
async function appendWeeklyLog(
	rows: ReportRow[],
	weekTotals: { credits: number; runs: number },
	fromMs: number,
	toMs: number,
): Promise<void> {
	if (!CONFIG.weeklyLogDatabaseId) return;
	if (!CONFIG.notionApiToken) {
		console.warn("△ WEEKLY_LOG_DATABASE_ID はあるが NOTION_API_TOKEN が無いため週次ログ追記をスキップ。");
		return;
	}
	const headers = {
		Authorization: `Bearer ${CONFIG.notionApiToken}`,
		"Notion-Version": "2022-06-28",
		"Content-Type": "application/json",
	};

	// --- その週の合計を集計 ---
	const weekLabel = `${fmtDate(fromMs)} – ${fmtDate(toMs)}`; // 例: 2026/08/24 – 2026/08/30
	// クレジット・実行回数は「今週分」（weekTotals）を使う。状態別件数は現在のエージェント状態から数える。
	const totalCredits = weekTotals.credits;
	const totalRuns = weekTotals.runs;
	const countBy = (status: string) => rows.filter((r) => r.status === status).length;

	// 「週次の所感・効果」以外の列。手入力を守るため所感は含めない。
	const properties: Record<string, unknown> = {
		"週": { title: [{ text: { content: weekLabel } }] },
		"期間": {
			date: {
				start: isoDateLocal(fromMs),
				end: isoDateLocal(toMs),
			},
		},
		"総消費クレジット": { number: totalCredits },
		"稼働中": { number: countBy("稼働中") },
		"上限到達": { number: countBy("上限到達") },
		"停止中": { number: countBy("停止中") },
		"総実行回数": { number: totalRuns },
	};

	// 同じ週（週ラベル一致）の既存行を探す
	const query = await fetch(
		`https://api.notion.com/v1/databases/${CONFIG.weeklyLogDatabaseId}/query`,
		{
			method: "POST",
			headers,
			body: JSON.stringify({
				filter: { property: "週", title: { equals: weekLabel } },
				page_size: 1,
			}),
		},
	).then((res) => res.json() as Promise<{ results?: Array<{ id: string }> }>);

	const existing = query.results?.[0];
	if (existing) {
		// 既存の週を更新（所感・効果は触らない）
		await notionWrite(`https://api.notion.com/v1/pages/${existing.id}`, "PATCH", { properties }, headers);
		console.log(`✓ 週次ログを更新しました（${weekLabel}／所感・効果は保持）。`);
	} else {
		// 新しい週として 1 行追加
		await notionWrite(
			`https://api.notion.com/v1/pages`,
			"POST",
			{ parent: { database_id: CONFIG.weeklyLogDatabaseId }, properties },
			headers,
		);
		console.log(`✓ 週次ログに 1 行追加しました（${weekLabel}）。`);
	}
}

/**
 * （任意）月次累積ログ DB に「当月の 1月起点 累積クレジット」を upsert する。
 * 「月」（YYYY-MM）をキーに、同じ月があれば更新・無ければ追加。推移グラフ（累積線）の元データ。
 */
async function appendMonthlyLog(rows: ReportRow[], nowMs: number): Promise<void> {
	if (!CONFIG.monthlyLogDatabaseId) return;
	if (!CONFIG.notionApiToken) {
		console.warn("△ MONTHLY_LOG_DATABASE_ID はあるが NOTION_API_TOKEN が無いため月次ログ更新をスキップ。");
		return;
	}
	const headers = {
		Authorization: `Bearer ${CONFIG.notionApiToken}`,
		"Notion-Version": "2022-06-28",
		"Content-Type": "application/json",
	};

	const d = new Date(nowMs);
	const y = d.getFullYear();
	const m = d.getMonth(); // 0-based
	const monthLabel = `${y}-${String(m + 1).padStart(2, "0")}`;
	const monthEnd = isoDateLocal(new Date(y, m + 1, 0).getTime()); // 当月末日
	// 詳細行の消費クレジットは「1月起点の累積」なので、その合計＝当月末時点の累積。
	const cumulative = rows.reduce((s, r) => s + r.creditsUsed, 0);

	const properties: Record<string, unknown> = {
		"月": { title: [{ text: { content: monthLabel } }] },
		"月末": { date: { start: monthEnd } },
		"累積消費クレジット": { number: cumulative },
	};

	const query = await fetch(
		`https://api.notion.com/v1/databases/${CONFIG.monthlyLogDatabaseId}/query`,
		{
			method: "POST",
			headers,
			body: JSON.stringify({ filter: { property: "月", title: { equals: monthLabel } }, page_size: 1 }),
		},
	).then((res) => res.json() as Promise<{ results?: Array<{ id: string }> }>);

	const existing = query.results?.[0];
	if (existing) {
		await notionWrite(`https://api.notion.com/v1/pages/${existing.id}`, "PATCH", { properties }, headers);
		console.log(`✓ 月次累積ログを更新しました（${monthLabel}：累積 ${cumulative} cr）。`);
	} else {
		await notionWrite(
			`https://api.notion.com/v1/pages`,
			"POST",
			{ parent: { database_id: CONFIG.monthlyLogDatabaseId }, properties },
			headers,
		);
		console.log(`✓ 月次累積ログに 1 行追加しました（${monthLabel}：累積 ${cumulative} cr）。`);
	}
}

// ===========================================================================
// メイン
// ===========================================================================

/**
 * （任意・高影響）詳細DBの「希望クレジット上限」を Admin API で実際のエージェントに書き戻す。
 * ENABLE_CREDIT_LIMIT_WRITEBACK=true のときのみ動作。Admin token に workflows:write が必要。
 * usageById の credit_limit を新値に更新するので、この後の upsert で「クレジット上限」列も最新になる。
 */
async function reconcileCreditLimits(agents: Agent[], usageById: Map<string, CreditUsage>): Promise<void> {
	if (!CONFIG.enableCreditWriteback) return;
	if (!CONFIG.notionApiToken || !CONFIG.outputDatabaseId) {
		console.warn("△ 書き戻し有効だが NOTION_API_TOKEN / OUTPUT_DATABASE_ID が無いためスキップ。");
		return;
	}
	const headers = {
		Authorization: `Bearer ${CONFIG.notionApiToken}`,
		"Notion-Version": "2022-06-28",
		"Content-Type": "application/json",
	};
	const MAX_LIMIT = 1000; // 希望クレジット上限の許容上限。これを超える希望値は適用しない。

	// 「希望クレジット上限」列を空欄に戻す（適用後に消費するため）。
	const clearDesired = async (pageId: string): Promise<void> => {
		await notionWrite(
			`https://api.notion.com/v1/pages/${pageId}`,
			"PATCH",
			{ properties: { "希望クレジット上限": { number: null } } },
			headers,
		);
	};

	// 詳細DBから「エージェントID → { 希望値, ページID }」を読み取る
	const desiredById = new Map<string, { desired: number; pageId: string }>();
	let cursor: string | undefined;
	do {
		const data = (await fetch(`https://api.notion.com/v1/databases/${CONFIG.outputDatabaseId}/query`, {
			method: "POST",
			headers,
			body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
		}).then((r) => r.json())) as any;
		for (const row of data.results ?? []) {
			const idText = (row.properties?.["エージェントID"]?.rich_text ?? [])
				.map((t: any) => t.plain_text)
				.join("");
			const desired = row.properties?.["希望クレジット上限"]?.number;
			if (idText && desired != null) desiredById.set(idText, { desired, pageId: row.id });
		}
		cursor = data.has_more ? data.next_cursor : undefined;
	} while (cursor);

	let changed = 0;
	let skipped = 0;
	for (const agent of agents) {
		const entry = desiredById.get(agent.id);
		if (!entry) continue;
		const { desired, pageId } = entry;

		// ① 上限ガード：1000 を超える希望値は適用しない（希望欄は残して気づけるように）
		if (desired > MAX_LIMIT) {
			console.warn(`  ⚠ ${agent.name}: 希望 ${desired} は上限 ${MAX_LIMIT} を超えるため適用しません。`);
			skipped++;
			continue;
		}

		const current = usageById.get(agent.id)?.credit_limit ?? null;
		if (desired === current) {
			// すでに一致 → 希望欄だけクリアして消費する
			await clearDesired(pageId);
			continue;
		}

		// ② Admin API で実際の上限を変更
		const resp = await adminPut(`/spaces/${CONFIG.spaceId}/agents/${agent.id}/credit_limit`, {
			credit_limit: desired,
		});
		const u = usageById.get(agent.id);
		if (u) u.credit_limit = resp?.enforced_credit_limit ?? desired; // 「現在の上限」を新値に更新
		// ③ 反映できたら「希望クレジット上限」を空欄に戻す
		await clearDesired(pageId);
		changed++;
		console.log(`  ✏ 上限変更: ${agent.name}  ${current ?? "—"} → ${desired}（希望欄クリア）`);
	}
	console.log(
		`・クレジット上限 書き戻し: 変更 ${changed} 件${skipped ? ` / 上限超過スキップ ${skipped} 件` : ""}。`,
	);
}

/**
 * （任意・高影響）詳細DBの「稼働状態」を Admin API に書き戻す。
 * 稼働中→停止中 に変えたら停止（disabled）、停止中→稼働中 に戻したら再開（active）。
 * ENABLE_STATUS_WRITEBACK=true のときのみ動作。Admin token に workflows:write が必要。
 * agent.status を新値に更新するので、この後の upsert で「稼働状態」列も最新になる。
 */
async function reconcileAgentStatus(agents: Agent[], usageById: Map<string, CreditUsage>): Promise<void> {
	if (!CONFIG.enableStatusWriteback) return;
	if (!CONFIG.notionApiToken || !CONFIG.outputDatabaseId) {
		console.warn("△ 状態書き戻し有効だが NOTION_API_TOKEN / OUTPUT_DATABASE_ID が無いためスキップ。");
		return;
	}
	const headers = {
		Authorization: `Bearer ${CONFIG.notionApiToken}`,
		"Notion-Version": "2022-06-28",
		"Content-Type": "application/json",
	};
	// 詳細DBから「エージェントID → 稼働状態（DBの現在値＝希望）」を読み取る
	const desiredById = new Map<string, string>();
	let cursor: string | undefined;
	do {
		const data = (await fetch(`https://api.notion.com/v1/databases/${CONFIG.outputDatabaseId}/query`, {
			method: "POST",
			headers,
			body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
		}).then((r) => r.json())) as any;
		for (const row of data.results ?? []) {
			const idText = (row.properties?.["エージェントID"]?.rich_text ?? [])
				.map((t: any) => t.plain_text)
				.join("");
			const st = row.properties?.["稼働状態"]?.select?.name;
			if (idText && st) desiredById.set(idText, st);
		}
		cursor = data.has_more ? data.next_cursor : undefined;
	} while (cursor);

	let stopped = 0;
	let resumed = 0;
	for (const agent of agents) {
		const desired = desiredById.get(agent.id);
		if (!desired) continue;
		const current = deriveStatus(agent, usageById.get(agent.id));
		if (desired === current) continue;
		try {
			if (desired === "停止中" && current === "稼働中") {
				await adminPatch(`/spaces/${CONFIG.spaceId}/agents/${agent.id}/status`, { admin_status: "disabled" });
				agent.status = "disabled_from_workspace_settings"; // 以後の upsert が「停止中」を書く
				stopped++;
				console.log(`  ⏸ 停止: ${agent.name}`);
			} else if (desired === "稼働中" && current === "停止中") {
				await adminPatch(`/spaces/${CONFIG.spaceId}/agents/${agent.id}/status`, { admin_status: "active" });
				agent.status = "active";
				resumed++;
				console.log(`  ▶ 再開: ${agent.name}`);
			}
			// 上限到達 / 削除済み などは対象外（APIが拒否するため触らない）
		} catch {
			console.warn(`  ⚠ ${agent.name}: 状態変更に失敗（他要因で保留中の可能性）。スキップ。`);
		}
	}
	console.log(
		stopped || resumed
			? `✓ 稼働状態 書き戻し: 停止 ${stopped} 件 / 再開 ${resumed} 件。`
			: "・稼働状態の変更対象はありませんでした。",
	);
}

/**
 * （任意）日次クレジットログ DB に「今日の各エージェントの日次消費」を upsert する。
 * エージェントID＋日付 をキーに、同じ日の同じエージェントは更新（重複しない）。推移グラフの元データ。
 * 消費のあるエージェント（累計>0）のみ記録する。
 */
/**
 * 日次クレジットログ DB から、指定した日付に記録済みの「エージェントID → 累積」を読む。
 *
 * ★ なぜ Admin API を直接使わないか：
 *   Admin API の `credit_usage_time_from/to` は「集計期間」ではなく、
 *   「そのエージェントの"最終利用時刻"がその範囲に入っているか」で結果に含めるかを決めるフィルタ。
 *   そのため、今日も使ったエージェントを「昨日まで」の窓で問い合わせると、
 *   最終利用（今日）が範囲外という理由で"該当なし"としてまるごと除外され、
 *   本来ある累積値の代わりに 0 として扱ってしまう（＝前日の消費が実際より少なく出るバグ）。
 *
 *   一方、日次クレジットログDBの各行は「その日の実行時点でのライブな累積」を記録したもの
 *   （＝過去に遡って問い合わせたものではない）なので、正確な値が残っている。
 *   前日/当日の単日消費は、このDB自身の記録を読み返して差分を取る。
 */
async function readDailyLogCumulative(dateIso: string): Promise<Map<string, number>> {
	const result = new Map<string, number>();
	if (!CONFIG.dailyLogDatabaseId || !CONFIG.notionApiToken) return result;
	const headers = {
		Authorization: `Bearer ${CONFIG.notionApiToken}`,
		"Notion-Version": "2022-06-28",
		"Content-Type": "application/json",
	};
	let cursor: string | undefined;
	do {
		const data = (await fetch(`https://api.notion.com/v1/databases/${CONFIG.dailyLogDatabaseId}/query`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				filter: { property: "日付", date: { equals: dateIso } },
				page_size: 100,
				...(cursor ? { start_cursor: cursor } : {}),
			}),
		}).then((res) => res.json())) as any;
		for (const row of data.results ?? []) {
			const idText = (row.properties?.["エージェントID"]?.rich_text ?? [])
				.map((t: any) => t.plain_text)
				.join("");
			const cum = row.properties?.["累積"]?.number;
			if (idText && cum != null) result.set(idText, cum);
		}
		cursor = data.has_more ? data.next_cursor : undefined;
	} while (cursor);
	return result;
}

async function appendDailyLog(rows: ReportRow[], nowMs: number): Promise<void> {
	if (!CONFIG.dailyLogDatabaseId) return;
	if (!CONFIG.notionApiToken) {
		console.warn("△ DAILY_LOG_DATABASE_ID はあるが NOTION_API_TOKEN が無いため日次ログをスキップ。");
		return;
	}
	const headers = {
		Authorization: `Bearer ${CONFIG.notionApiToken}`,
		"Notion-Version": "2022-06-28",
		"Content-Type": "application/json",
	};
	const today = isoDateLocal(nowMs);
	let n = 0;
	let renamed = 0;
	for (const r of rows) {
		if (r.creditsUsed <= 0) continue; // 消費のあるエージェントのみ

		// エージェント名が変わっていたら、過去の行（今日以外）の名前も現在名に揃える。
		// 「エージェント」列は書き込み時点の名前スナップショットなので、改名すると
		// 推移グラフ（名前でグルーピング）が新旧2本の線に分裂してしまうのを防ぐ。
		const pastRows = (await fetch(`https://api.notion.com/v1/databases/${CONFIG.dailyLogDatabaseId}/query`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				filter: {
					and: [
						{ property: "エージェントID", rich_text: { equals: r.id } },
						{ property: "エージェント", rich_text: { does_not_equal: r.name } },
					],
				},
				page_size: 100,
			}),
		}).then((res) => res.json())) as { results?: Array<{ id: string; properties: any }> };
		for (const old of pastRows.results ?? []) {
			const date = old.properties?.["日付"]?.date?.start ?? "";
			await notionWrite(
				`https://api.notion.com/v1/pages/${old.id}`,
				"PATCH",
				{
					properties: {
						"エージェント": { rich_text: [{ text: { content: r.name } }] },
						"記録": { title: [{ text: { content: `${date} / ${r.name}` } }] },
					},
				},
				headers,
			);
			renamed++;
		}

		const daily = r.creditsUsed - r.prevCreditsUsed;
		// エージェントID＋日付 で既存行を検索（同日同エージェントは1行）
		const query = (await fetch(`https://api.notion.com/v1/databases/${CONFIG.dailyLogDatabaseId}/query`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				filter: {
					and: [
						{ property: "エージェントID", rich_text: { equals: r.id } },
						{ property: "日付", date: { equals: today } },
					],
				},
				page_size: 1,
			}),
		}).then((res) => res.json())) as { results?: Array<{ id: string }> };
		const properties: Record<string, unknown> = {
			"記録": { title: [{ text: { content: `${today} / ${r.name}` } }] },
			"日付": { date: { start: today } },
			"エージェント": { rich_text: [{ text: { content: r.name } }] },
			"エージェントID": { rich_text: [{ text: { content: r.id } }] },
			"当日消費": { number: daily },
			"累積": { number: r.creditsUsed },
		};
		const existing = query.results?.[0];
		if (existing) {
			await notionWrite(`https://api.notion.com/v1/pages/${existing.id}`, "PATCH", { properties }, headers);
		} else {
			await notionWrite(
				`https://api.notion.com/v1/pages`,
				"POST",
				{ parent: { database_id: CONFIG.dailyLogDatabaseId }, properties },
				headers,
			);
		}
		n++;
	}
	console.log(
		`✓ 日次ログを更新しました（${today}・${n} エージェント）${renamed ? `／名前スナップショットを${renamed}件更新` : ""}。`,
	);
}

async function main(): Promise<void> {
	const now = Date.now();
	// 集計期間は「今週（月曜〜日曜）」に固定。
	// これにより 30 分ごとに実行しても週次ログは 1 週間＝1 行のまま更新され続ける。
	const { fromMs, toMs } = currentCalendarWeek(now);

	console.log("→ Admin API からデータ取得中 …");
	await loadDepartmentMap();
	await loadCreatorDepartmentMap(); // 作成者→部署（People DB）
	// 累積の起点は「今年の1月1日」。
	const d0 = new Date(now);
	const yearStartMs = new Date(d0.getFullYear(), 0, 1, 0, 0, 0, 0).getTime();
	const yesterdayIso = isoDateLocal(new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() - 1).getTime());
	const twoDaysAgoIso = isoDateLocal(new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() - 2).getTime());

	// クレジットは2つの窓で取得する:
	//   - 1月起点〜現在 … 詳細DB「消費クレジット」／月次累積ログ用（"現在"問い合わせなので信頼できる）
	//   - 今週（月〜日）… 週次ログ用（週初は0から積み上がる）
	// ★ 前日/当日の単日消費は Admin API へ過去の時点を問い合わせない（readDailyLogCumulative 参照）。
	//   代わりに、日次クレジットログDB自身が記録した過去の累積（ライブ記録）を読み返す。
	const [agents, usageCumulative, usageThisWeek, prevDayLedger, twoDaysAgoLedger] = await Promise.all([
		fetchAgents(),
		fetchCreditUsage(yearStartMs, now),
		fetchCreditUsage(fromMs, toMs),
		readDailyLogCumulative(yesterdayIso),
		readDailyLogCumulative(twoDaysAgoIso),
	]);

	// （任意）クレジット上限の書き戻し：希望値→Admin API。usageCumulative の credit_limit を最新化。
	const usageById = new Map(usageCumulative.map((u) => [u.id, u]));
	await reconcileCreditLimits(agents, usageById);
	await reconcileAgentStatus(agents, usageById); // 稼働状態の書き戻し（稼働中↔停止中）

	// 詳細行を作る（前日・当日の単日消費も付与）。
	const rows = await buildRows(agents, usageCumulative, prevDayLedger, twoDaysAgoLedger);

	// 週次ログ用に「今週分」の合計を算出。
	const weekTotals = {
		credits: usageThisWeek.reduce((s, u) => s + (u.total_credits_used ?? 0), 0),
		runs: usageThisWeek.reduce((s, u) => s + (u.runs_completed ?? 0), 0),
	};

	printConsole(rows, fromMs, toMs);
	await writeJson(rows, fromMs, toMs);
	await upsertToNotion(rows); // OUTPUT_DATABASE_ID 未設定なら何もしない（1行＝1エージェント・累計）
	await appendWeeklyLog(rows, weekTotals, fromMs, toMs); // WEEKLY_LOG_DATABASE_ID 未設定なら何もしない（1行＝1週間・今週分）
	await appendMonthlyLog(rows, now); // MONTHLY_LOG_DATABASE_ID 未設定なら何もしない（1行＝1ヶ月・1月起点の累積）
	await appendDailyLog(rows, now); // DAILY_LOG_DATABASE_ID 未設定なら何もしない（1行＝1エージェント×1日）
}

main().catch((err) => {
	console.error("\n✗ 失敗しました:\n", err);
	process.exit(1);
});
