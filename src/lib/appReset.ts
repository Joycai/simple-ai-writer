/**
 * 重置应用配置 —— 把这台机器上的应用配置清回刚装好的样子。
 *
 * ## 清什么，不清什么
 *
 * 清的是**装机级配置**：`config.db` 里的供应商 / 模型 / 计费组 / Prompt /
 * 排版格式、`lib/prefs` 里的全部偏好，以及 OS 钥匙串里这个应用存的密钥。
 *
 * **总体用量**（`config.db` 的 `token_usage`）跟着一起清：它是配置库的一部分，
 * 而重置之后模型和计费组都不在了，留着一堆指向不存在的模型的行只会在用量页上
 * 显示成一串「已删除的模型」。项目文件夹里的那一份不动——理由在下一段。
 *
 * **不碰**作者的稿子：项目文件夹里的文档、`.ai-writer/` 下的知识库、
 * `project.db` 里的用量与对话记录，一个字节都不动——它们在文件系统上，不属于
 * 「应用配置」，而重置一台机器的配置和毁掉几十万字是两件事，一个按钮不该同时
 * 意味着两者。同理，`appDataDir/backups` 里那些**拉取前的知识库压缩包**也留着：
 * 它们是安全网，装的正是重置本身无法再生成的东西。
 *
 * **下载过的字体包**（`appDataDir/fonts`，鸿蒙黑体 / MiSans）会清：它们是
 * 本机缓存，刚装好的应用本来就没有，要用时选中即可重新下载。重置时若还有下载
 * 在跑，它可能在删除之后又写回一两个分片——没有完成标记，不算装好，调用方
 * 紧接着重载窗口也就停了；残片只占磁盘，不碍正确性。
 *
 * ## 顺序：先钥匙串，后数据库
 *
 * `providers` 那几行是「钥匙串里有哪些账户」的**唯一记录**。先删行再删密钥，
 * 中间断了就会留下一堆谁也叫不出名字的密钥，永远清不掉；反过来断了，作者看到
 * 的是「供应商还在，密钥没了」——重新填一次就好。所以钥匙串拒绝时这里直接抛，
 * 数据库一行不动（和 `lib/sync` 说「安全网缺席的那一次拉取正是不该开始的那一
 * 次」是同一条道理）。
 *
 * ## 够不着的那一处
 *
 * 钥匙串没有「列出全部」这件事——除了 macOS，它把所有密钥折进一个钥匙串条目，
 * 于是清空那个条目就是清空全部。Windows / Linux 是一个 id 一条凭据，只能按名
 * 字删，所以这里能删的就是它**叫得出名字**的那些：每个供应商、知识库同步服务器
 * 的 token。作者勾过「记住密码」的配置备份密码（`cfgpwd:<服务器>:<档>`）叫不
 * 出名字——档的 id 只在连上服务器时才知道——那一条会留在钥匙串里，取消勾选
 * 或删掉那个档才会消失。为了它去连一次网络，或者为了记住它再引入一份注册表，
 * 都比这条残留本身更贵。
 */

import { listProviders, listModels, listPrompts, ensureAiSchema, dropLegacyKeyTable } from "./ai/configDb";
import { loadCustomFormats } from "./docx/presets";
import { clearAllSecrets } from "./keyStore";
import { clearAllPrefs, prefEntries } from "./prefs";
import { getGlobalDb, getGlobalDbPath } from "./project";
import { sqlTransaction } from "./sqlTx";
import { fileExists, removeDir } from "./fs/fileio";
import { fontsRoot } from "./theme/fontPacks";
import { getServerUrl, syncTokenAccount } from "./sync/config";

/** 将要被清掉的东西，按作者看得见的单位数出来。 */
export interface ResetInventory {
  providers: number;
  models: number;
  prompts: number;
  docFormats: number;
  /** 偏好条数（主题、面板宽度、模型选择、最近项目……）。 */
  prefs: number;
  /** 这台机器上叫得出名字的密钥账户数——见模块头「够不着的那一处」。 */
  secrets: number;
}

/** 钥匙串拒绝删除时抛出。数据库此时一行未动。 */
export class SecretWipeError extends Error {
  constructor(public readonly failed: number) {
    super(`the OS keyring refused to delete ${failed} secret(s)`);
    this.name = "SecretWipeError";
  }
}

async function configDb() {
  const db = await getGlobalDb();
  await ensureAiSchema(db);
  return db;
}

/**
 * 数一遍将要清掉的东西。
 *
 * 确认框上的数字必须从**真东西**上算，不能写死在文案里：一句「将清除全部配置」
 * 在一台什么都没配过的机器上和一台配了十八个供应商的机器上长得一模一样，而这
 * 两次按下去的后果完全不同。（`lib/configsync/envelope` 关于自报 counts 只能
 * 被显示、不能被当作依据的那条，是同一件事的另一面。）
 */
export async function collectResetInventory(): Promise<ResetInventory> {
  const db = await configDb();
  const [providers, models, prompts, docFormats] = await Promise.all([
    listProviders(db),
    listModels(db),
    listPrompts(db),
    // 表可能还没建起来（从没用过 Word 导出）——读不出来就是零份。
    loadCustomFormats().catch(() => []),
  ]);
  return {
    providers: providers.length,
    models: models.length,
    prompts: prompts.length,
    docFormats: docFormats.length,
    prefs: prefEntries().length,
    secrets: secretAccounts(providers.map((p) => p.id)).length,
  };
}

/** 叫得出名字的钥匙串账户：每个供应商，加上同步服务器的 token。 */
function secretAccounts(providerIds: string[]): string[] {
  const server = getServerUrl();
  return server ? [...providerIds, syncTokenAccount(server)] : providerIds;
}

interface ResetSummary {
  inventory: ResetInventory;
  /** 钥匙串实际删掉的条数。macOS 上会超过 `inventory.secrets`——那里能清全部。 */
  secretsRemoved: number;
}

/**
 * 执行重置。调用方随后必须重载窗口：内存里的 store 和偏好缓存还停在旧值上，
 * 而重新走一遍 `main.tsx` 的启动（空的 prefs → 引导页）恰好就是想要的结果。
 */
export async function resetApp(): Promise<ResetSummary> {
  const inventory = await collectResetInventory();
  const db = await configDb();
  const providers = await listProviders(db);

  // 1. 钥匙串先走。被拒就整件事作废——见模块头「顺序」。
  const wipe = await clearAllSecrets(secretAccounts(providers.map((p) => p.id)));
  if (wipe.failed > 0) throw new SecretWipeError(wipe.failed);

  // 2. 配置表一次事务。models 先于 providers：外键虽然是 CASCADE，但让删除
  //    顺序自己成立比依赖它清楚。
  await sqlTransaction(await getGlobalDbPath(), [
    { sql: "DELETE FROM models", values: [] },
    { sql: "DELETE FROM providers", values: [] },
    { sql: "DELETE FROM prompts", values: [] },
    // 组在引用它的两张表之后：删空的顺序自己成立，比依赖「反正没外键」清楚。
    { sql: "DELETE FROM fee_groups", values: [] },
    // 总体用量。项目文件夹里的那一份不动——那是作者的稿子那一边的东西。
    { sql: "DELETE FROM token_usage", values: [] },
  ]);

  // 3. 排版格式和历史遗留的明文密钥表都不在上面那个事务里，理由和
  //    `applyConfigImport` 一样：它们和上面几张表没有外键关系，塞进去只会把
  //    「数据库被锁住」的窗口开得更大，去撤销一次已经成功的清除。表不存在
  //    （从没用过 Word 导出 / 全新安装）就是本来就没有。
  try {
    await db.execute("DELETE FROM doc_format");
  } catch {
    /* 没建过这张表 */
  }
  try {
    await dropLegacyKeyTable(db);
  } catch {
    /* 早就没有了 */
  }

  // 4. 下载过的字体包。它只是本机缓存，不是作者的东西，但「回到第一次打开
  //    的样子」本来就没有它；删不掉也不挡重置，下次选中时照样能再下载。
  try {
    const fonts = await fontsRoot();
    if (await fileExists(fonts)) await removeDir(fonts);
  } catch {
    /* 留着也无害 */
  }

  // 5. 偏好最后，并且是 await 的——调用方紧接着就要重载窗口。
  await clearAllPrefs();

  return { inventory, secretsRemoved: wipe.removed };
}
