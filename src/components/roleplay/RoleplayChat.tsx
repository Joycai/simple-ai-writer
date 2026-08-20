/**
 * 一个 agent 的对话区（设计稿 08 屏 1a / 1b / 1e / 1h）。
 *
 * 稿面而不是聊天：一栏 640px 居中、与编辑器正文同宽，作者的回合只用一条 2px
 * 赭石左规 + 一个小号名标区分，角色的回合直接落在纸上。没有气泡、没有左右
 * 分栏、没有小尾巴——理由写在设计稿 1c：气泡把每条消息切成独立单元，而剧本
 * 要的是连续的稿面。
 *
 * 输入框的实时着色只改**颜色**，不改字号、字重、字形。设计稿给四种标记各配了
 * 字号（16/18/15/12）和斜体，那是**稿面**的排版；输入框是一个 textarea 上面
 * 盖一层镜像 div，任何度量差异都会让光标和字错位。所以这里只换色——「边打边
 * 变」要传达的是「标记生效了」，而颜色足以传达它。中文输入法组字期间镜像层
 * 让位给原生文本，否则作者会对着一片透明打字。
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Image as ImageIcon, RotateCw, X } from "lucide-react";
import { useRoleplayStore } from "../../stores/roleplayStore";
import { useLoreStore } from "../../stores/loreStore";
import { listArchives, type ArchivedScene } from "../../lib/roleplay/store";
import { useProjectStore } from "../../stores/projectStore";
import { ModelSelector } from "../ai/ModelSelector";
import { AgentLog } from "../ai/AgentLog";
import { ApprovalCard } from "../ai/ApprovalCard";
import { RoundLimitCard } from "../ai/RoundLimitCard";
import { TruncationCard } from "../ai/TruncationCard";
import { useAgentStore } from "../../stores/agentStore";
import { useAiStore } from "../../stores/aiStore";
import { readPref, writePref } from "../../lib/prefs";
import { useAppStore } from "../../stores/appStore";
import { computeContextBreakdown } from "../../lib/agent/contextBreakdown";
import { getToolDefinitions } from "../../lib/agent/registry";
import { routePlannedTools } from "../../lib/agent/routing";
import { estimateToolsTokens } from "../../lib/ai/tokenEstimate";
import { inputCeilingFor } from "../../lib/context/budget";
import { presetFor } from "../../lib/roleplay/presets";
import {
  chainCanSeeImages, withSessionOverrides, type SubAgentKind,
} from "../../lib/agent/subagent";
import { MAX_IMAGE_BYTES, imageToDataUrl } from "../../lib/fs/images";
import { attachedKey } from "../../lib/lore/aiTask";
import { cardsForSurface } from "../../lib/agent/approvalRouting";
import { ScriptText } from "./ScriptText";
import { ArchiveViewer } from "./ArchiveViewer";
import { SubAgentChips } from "../ai/SubAgentChips";
import { ContextBar } from "../ai/ContextBar";
import { SnippetPicker } from "../ai/SnippetPicker";
import { useAiTaskStore } from "../../stores/aiTaskStore";
import { MemoryPanel } from "./MemoryPanel";
import {
  MentionPicker, filterMentions, mentionKey, mentionLabel,
  useMentionState, type MentionItem,
} from "../common/MentionPicker";
import { classifySegment } from "../../lib/roleplay/markup";
import { projectFilesFromTree } from "../../lib/fs/images";
import { readFile } from "../../lib/fs/fileio";
import type { AttachedItem } from "../../lib/lore/aiTask";
import type {
  AuthorPersona, MemoryRecord, RoleplayAgent, SceneTurn,
} from "../../lib/roleplay/model";
import styles from "./RoleplayChat.module.css";

/** 一个稳定的空数组：会话还没建起来时给它，省得每帧换一个新引用。 */
const EMPTY_SUBS: SubAgentKind[] = [];

/** `+ …` 三个按钮各自把选择器限制到哪一类候选。 */
type PickKind = "lore" | "text" | "image";

function matchesKind(item: MentionItem, kind: PickKind): boolean {
  return kind === "lore" ? item.type === "lore" : item.type === "file" && item.file.kind === kind;
}

const MIRROR_CLASS: Record<string, string> = {
  action: styles.mirrorAction,
  speech: styles.mirrorSpeech,
  scene: styles.mirrorScene,
  meta: styles.mirrorMeta,
};

/**
 * 输入框镜像层。**逐行**着色，空行原样保留——丢一行光标就往上跳一行。
 * 只换颜色：字号、字重、字形一律与 textarea 相同，任何度量差异都会让光标
 * 和字错开。
 */
function ComposerMirror({ text, innerRef }: {
  text: string;
  /** 必须挂在 `.mirror` 自己身上：滚动同步设的是**它**的 scrollTop。 */
  innerRef: React.Ref<HTMLDivElement>;
}) {
  return (
    <div ref={innerRef} className={styles.mirror} aria-hidden>
      {text.split(/\r?\n/).map((line, i) => {
        const seg = classifySegment(line, { requireClosed: true });
        return (
          <div key={i} className={seg ? MIRROR_CLASS[seg.kind] : styles.mirrorScene}>
            {line || "\u200b"}
          </div>
        );
      })}
    </div>
  );
}

function TurnBlock({ turn, log, memories, onRewind }: {
  turn: SceneTurn;
  log?: React.ReactNode;
  /** 这一轮里角色记下的东西。作者手加的 `turn: 0`，永远不会落在这里。 */
  memories?: MemoryRecord[];
  /** 只有作者轮、且不是最后一轮时给——回到最后一轮等于什么也没撤销。 */
  onRewind?: () => void;
}) {
  const { t } = useTranslation();
  if (turn.speaker === "author") {
    return (
      <div className={styles.authorTurn} id={`rp-turn-${turn.index}`}>
        <div className={styles.authorLabel}>
          {t("roleplay.me", { defaultValue: "我" })}
          {turn.speakerName && <span className={styles.personaName}>{turn.speakerName}</span>}
          {/* 悬停才出现：它是一个撤销动作，不该在稿面上一直举着手。 */}
          {onRewind && (
            <button type="button" className={styles.rewindBtn} onClick={onRewind}>
              {t("roleplay.rewind.here", { defaultValue: "回到这里重说" })}
            </button>
          )}
        </div>
        <ScriptText text={turn.text} />
      </div>
    );
  }
  return (
    <>
      <div className={styles.agentTurn} id={`rp-turn-${turn.index}`}>
        <div className={styles.agentLabel}>{turn.speakerName}</div>
        <ScriptText text={turn.text} />
      </div>
      {/* 很轻的一道痕迹：不能像系统通知那样打断阅读，但也不能轻到看不见——
          作者需要知道角色**真的**记住了，这是建立信任的地方。 */}
      {memories?.map((m) => (
        <div key={m.id} className={styles.memoryTrace}>
          <span className={styles.memoryDot} />
          {t("roleplay.memory.recorded", { title: m.title, defaultValue: `记下了：${m.title}` })}
        </div>
      ))}
      {log}
    </>
  );
}

export function RoleplayChat({ agent, onEdit }: { agent: RoleplayAgent; onEdit: () => void }) {
  const { t } = useTranslation();
  const {
    sessions, running, queue, stale, send, stop, retry, rewind, dequeue, promote, toggleSubAgent,
    refreshBinding, setAgentModel,
  } = useRoleplayStore();
  const session = sessions[agent.id];
  const isRunning = running.includes(agent.id);
  const queuePos = queue.findIndex((j) => j.agentId === agent.id);

  const [draft, setDraft] = useState("");
  const [composing, setComposing] = useState(false);
  // 第一次进来默认展开：折起来之后它只剩四个符号，不认识的人不会去点「展开」。
  // 作者亲手收起过一次就记住，此后一直折着。
  const [showSyntax, setShowSyntax] = useState(() => readPref("app:roleplaySyntaxSeen") !== "1");
  const [showBindings, setShowBindings] = useState(false);
  const [openLog, setOpenLog] = useState<number | null>(null);
  const [refs, setRefs] = useState<AttachedItem[]>([]);
  /** 被拒的附件（太大 / 读不到）。下一次挑选会清掉它。 */
  const [refError, setRefError] = useState<string | null>(null);
  /** `+ 条目 / + 文档 / + 图片` 打开选择器时把候选限制到那一类。 */
  const [pickKind, setPickKind] = useState<PickKind | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [showMemory, setShowMemory] = useState(false);
  // 封存的旧场次。挂在对话区而不是 store 里：它只在作者往上看的时候才有意义，
  // 而每次切 agent 重读一次目录比让 store 多背一份状态便宜。
  const [archives, setArchives] = useState<ArchivedScene[]>([]);
  const [showArchive, setShowArchive] = useState(false);
  /** 待确认的回退目标轮号。回退会撤销记录，所以要问一次。 */
  const [rewindTo, setRewindTo] = useState<number | null>(null);
  /**
   * 作者主动摘掉了这次的选区。
   *
   * 默认带上——有选区几乎总意味着「我说的是这一段」。摘掉之后在编辑器里重新
   * 划一次就会再带上（`selection` 换了新值，这个开关也跟着复位）。
   */
  const [detached, setDetached] = useState(false);

  const taRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 被这个 agent 阻塞住的卡片。按 surface 取，而不是把 agentStore 的队列整个
  // 渲染出来——三个 agent 并发时，不区分就等于每个面板都显示别人的卡片，而
  // 旁白的那张会跑到「对话助手」tab 里去（lib/agent/approvalRouting）。
  const approvals = cardsForSurface(useAgentStore((s) => s.pending), agent.id);
  const roundLimits = cardsForSurface(useAgentStore((s) => s.pendingRoundLimits), agent.id);
  const truncations = cardsForSurface(useAgentStore((s) => s.pendingTruncations), agent.id);

  const loreIndex = useLoreStore((s) => s.index);
  const fileTree = useProjectStore((s) => s.fileTree);
  const projectPath = useProjectStore((s) => s.projectPath);
  const mention = useMentionState();

  const models = useAiStore((s) => s.models);
  const subAgents = useAiStore((s) => s.subAgents);
  const activeModelId = useAiStore((s) => s.activeModelId);
  const boundModel = useMemo(
    () => models.find((m) => m.id === (agent.modelId ?? activeModelId)),
    [models, agent.modelId, activeModelId],
  );
  const disabledSubs = session?.disabledSubAgents ?? EMPTY_SUBS;
  const effectiveSubs = useMemo(
    () => withSessionOverrides(subAgents, disabledSubs),
    [subAgents, disabledSubs],
  );
  /**
   * 这条链看不看得见图片：本模型是多模态，或者识图子代理还开着。看不见就不把
   * 图片放进候选——挂一个模型物理上读不到的附件，作者只会看见一个芯片，然后
   * 角色像什么都没有一样回答。
   */
  const canSeeImages = chainCanSeeImages(boundModel, effectiveSubs, models);

  const selection = useAiTaskStore((s) => s.selection);
  useEffect(() => { setDetached(false); }, [selection]);
  const quote = !detached && selection ? selection : undefined;

  const contextUtilization = useAppStore((s) => s.contextUtilization);
  /**
   * 工具 schema 的开销。按**路由之后**的工具算（子代理会摘掉 read_image、补上
   * delegate），否则这一段会和它旁边那排芯片说的不是同一回事。
   */
  const toolTokens = useMemo(
    () => estimateToolsTokens(
      getToolDefinitions(routePlannedTools(presetFor(agent.kind), effectiveSubs, models).tools),
    ),
    [agent.kind, effectiveSubs, models],
  );
  const contextVersion = session?.contextVersion ?? 0;
  const context = useMemo(
    () => computeContextBreakdown(
      session?.history ?? null,
      session?.meta ?? null,
      toolTokens,
      inputCeilingFor(boundModel?.contextSize, contextUtilization),
      boundModel?.contextSize ?? 0,
    ),
    // `contextVersion` 才是真正的触发器：history 是就地改的，引用永远不变。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session?.history, session?.meta, contextVersion, toolTokens, boundModel?.contextSize, contextUtilization],
  );

  const candidates: MentionItem[] = useMemo(() => [
    ...Object.values(loreIndex).flat().map((entity): MentionItem => ({ type: "lore", entity })),
    ...projectFilesFromTree(fileTree)
      .filter((f) => f.kind === "text" || (f.kind === "image" && canSeeImages))
      .map((file): MentionItem => ({ type: "file", file })),
  ], [loreIndex, fileTree, canSeeImages]);

  // 生成中的计时，设计稿在名标旁边显示「生成中 · 4.2s」。
  useEffect(() => {
    if (!isRunning) { setSeconds(0); return; }
    const started = Date.now();
    const id = window.setInterval(() => setSeconds((Date.now() - started) / 1000), 100);
    return () => window.clearInterval(id);
  }, [isRunning]);

  /**
   * 镜像层跟着 textarea 滚。
   *
   * 超过可见行数之后 textarea 会自己滚（光标要跟着走），镜像层不跟就等于带色
   * 的字停在原地、光标和真正的文本各走各的。
   *
   * 只挂 onScroll 不够，因为组字期间镜像层是**卸载**的（让位给原生文本），
   * 组完字重新挂上来时 scrollTop 归零——而这中间 textarea 早滚下去了。中文
   * 输入法下每打一个词都会撞上这条。所以 draft / composing 一变就补一次。
   */
  const syncMirror = () => {
    const ta = taRef.current, mirror = mirrorRef.current;
    if (ta && mirror) mirror.scrollTop = ta.scrollTop;
  };
  useLayoutEffect(syncMirror, [draft, composing]);

  // 新内容到达就滚到底。用 layout effect，否则会看到一帧的旧位置。
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [session?.turns.length, session?.streaming]);

  useEffect(() => {
    setShowArchive(false);
    if (!projectPath) { setArchives([]); return; }
    let alive = true;
    void listArchives(projectPath, agent.id)
      .then((list) => { if (alive) setArchives(list); })
      .catch(() => { if (alive) setArchives([]); });
    return () => { alive = false; };
    // turnCount 变化 = 这个 agent 刚被「新开会话」（归零）或又聊了一轮，
    // 前者会多出一场存档。
  }, [projectPath, agent.id, agent.turnCount]);

  const boundCount = agent.boundPaths.length;
  const openMemoryCount = (session?.memory ?? []).filter((m) => m.status === "open").length;
  const memoriesByTurn = useMemo(() => {
    const map = new Map<number, MemoryRecord[]>();
    for (const m of session?.memory ?? []) {
      if (m.turn <= 0) continue;
      const list = map.get(m.turn) ?? [];
      list.push(m);
      map.set(m.turn, list);
    }
    return map;
  }, [session?.memory]);

  const jumpToTurn = (turn: number) => {
    document.getElementById(`rp-turn-${turn}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  const canSend = draft.trim().length > 0;

  const doSend = () => {
    if (!canSend) return;
    void send(agent.id, draft, refs, quote);
    setDraft("");
    setRefs([]);
    setRefError(null);
    // 发完就摘掉：同一段选区跟着后面每一条消息一路走下去，是在替作者做一个他
    // 只做过一次的决定。想再带上，在编辑器里重新划一次。
    setDetached(true);
  };

  const mentionItems = useMemo(
    () => filterMentions(
      pickKind ? candidates.filter((c) => matchesKind(c, pickKind)) : candidates,
      mention.query,
    ),
    [candidates, mention.query, pickKind],
  );

  /**
   * `+ 条目` 这类按钮只是替作者敲了一个 `@`。
   *
   * 走同一条 splice，是为了只有一条代码路径：选中的东西以同样的方式落进正文，
   * 芯片也以同样的方式出现。否则「点按钮加的」和「打 @ 加的」会长出两套语义。
   */
  const openMentionFor = (kind: PickKind) => {
    const el = taRef.current;
    const caret = el?.selectionStart ?? draft.length;
    const before = draft.slice(0, caret);
    // `foo@bar` 是地址不是提名——findMention 拒绝跟在 ASCII 词字符后面的 `@`，
    // 所以这里先补一个边界，别丢下一个什么都打不开的 `@`。中文不需要。
    const pad = /[\w@]$/.test(before) ? " " : "";
    const at = caret + pad.length;
    const next = `${before}${pad}@${draft.slice(caret)}`;
    setPickKind(kind);
    setDraft(next);
    mention.sync(next, at + 1);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + 1, at + 1);
    });
  };
  const refKeys = useMemo(() => new Set(refs.map(attachedKey)), [refs]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention.open && mentionItems.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); mention.move(1, mentionItems.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); mention.move(-1, mentionItems.length); return; }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        void handlePickMention(mentionItems[mention.active]);
        return;
      }
      if (e.key === "Escape") { e.preventDefault(); mention.close(); return; }
    }
    if (e.key === "Enter" && !e.shiftKey && !composing) {
      e.preventDefault();
      doSend();
    }
  };

  const handlePickMention = async (item: MentionItem) => {
    if (refKeys.has(mentionKey(item))) { mention.close(); setPickKind(null); return; }
    setRefError(null);
    setDraft((prev) => mention.accept(prev, mentionLabel(item)));
    mention.close();
    setPickKind(null);
    if (item.type === "lore") {
      setRefs((r) => [...r, { kind: "lore", entity: item.entity }]);
    } else if (item.file.kind === "image") {
      try {
        const { dataUrl, bytes } = await imageToDataUrl(item.file.path);
        // 在**选中的这一刻**就拒绝，不留到发送时：那时作者早忘了自己挑过什么，
        // 一条悄悄少了张图的消息从记录上根本看不出来。
        if (bytes.length > MAX_IMAGE_BYTES) {
          setRefError(t("roleplay.composer.imageTooLarge", {
            name: item.file.name,
            size: (bytes.length / 1024 / 1024).toFixed(1),
            max: MAX_IMAGE_BYTES / 1024 / 1024,
            defaultValue: `${item.file.name} 太大（${(bytes.length / 1024 / 1024).toFixed(1)}MB，上限 ${MAX_IMAGE_BYTES / 1024 / 1024}MB）`,
          }));
          return;
        }
        setRefs((r) => [...r, { kind: "image", file: item.file, dataUrl }]);
      } catch {
        setRefError(t("roleplay.composer.refUnreadable", {
          name: item.file.name, defaultValue: `读不到 ${item.file.name}`,
        }));
      }
    } else if (projectPath) {
      try {
        const content = await readFile(item.file.path);
        setRefs((r) => [...r, { kind: "text", file: item.file, content }]);
      } catch {
        setRefError(t("roleplay.composer.refUnreadable", {
          name: item.file.name, defaultValue: `读不到 ${item.file.name}`,
        }));
      }
    }
  };

  const boundEntries = useMemo(() => {
    const byDir = new Map<string, { name: string; facets: { file: string; title: string }[] }>();
    for (const entities of Object.values(loreIndex)) {
      for (const e of entities) {
        byDir.set(e.dirPath, {
          name: e.name,
          facets: (e.facets ?? []).map((f) => ({ file: f.file, title: f.title })),
        });
      }
    }
    return agent.boundPaths.map((raw) => {
      const hash = raw.lastIndexOf("#");
      const dir = byDir.has(raw) || hash < 0 ? raw : raw.slice(0, hash);
      const facetFile = byDir.has(raw) || hash < 0 ? null : raw.slice(hash + 1);
      const entity = byDir.get(dir);
      const facet = facetFile ? entity?.facets.find((f) => f.file === facetFile) : null;
      const gone = !entity || (facetFile !== null && !facet);
      return {
        raw,
        label: entity
          ? `${entity.name}${facet ? ` · ${facet.title}` : ""}`
          : dir.split(/[/\\]/).pop() ?? raw,
        gone,
      };
    });
  }, [agent.boundPaths, loreIndex]);

  return (
    <div className={styles.pane}>
      <div className={styles.main}>
      {/* ── 顶部信息带 ── 一行小字，需要时才展开 ── */}
      <div className={`${styles.band} ${showMemory ? styles.bandNarrow : ""}`}>
        <span className={styles.bandName}>{agent.name}</span>
        {agent.kind === "narrator" && <span className={styles.kindTag}>NARRATOR</span>}
        <span className={styles.sep} />
        <button
          type="button"
          className={styles.bandBtn}
          onClick={() => setShowBindings((v) => !v)}
        >
          {t("roleplay.band.bound", { n: boundCount, defaultValue: `绑定 ${boundCount} 项设定` })}
          <ChevronDown size={9} strokeWidth={2.4} />
        </button>
        <span className={styles.sep} />
        {/* 「本角色」不是装饰：抽屉头部那个 picker 长得一模一样，改的却是全局
            默认值，而这一个是**永久重绑这个 agent**。两个控件同形不同义，标签
            是唯一能当场分清它们的东西。 */}
        <div className={styles.modelSlot}>
          <ModelSelector
            prefix={t("roleplay.band.modelScope", { defaultValue: "本角色" })}
            value={agent.modelId ?? undefined}
            onChange={(id) => void setAgentModel(agent.id, id)}
            onFollowGlobal={() => void setAgentModel(agent.id, null)}
          />
        </div>
        <button
          type="button"
          className={`${styles.bandBtn} ${showMemory ? styles.bandBtnOn : ""}`}
          onClick={() => setShowMemory((v) => !v)}
        >
          {t("roleplay.memory.open", { defaultValue: "记事本" })}
          {openMemoryCount > 0 && <span className={styles.memoryCount}>{openMemoryCount}</span>}
        </button>
        <div className={styles.spacer} />
        <span className={styles.isolation}>
          {agent.kind === "narrator"
            ? t("roleplay.band.narratorScope", { defaultValue: "可读全部角色记录" })
            : t("roleplay.band.isolated", { defaultValue: "记忆独立 · 仅此角色可见" })}
        </span>
        <button type="button" className={styles.bandBtn} onClick={onEdit}>
          {t("roleplay.editAgent", { defaultValue: "编辑" })}
        </button>
      </div>

      {showBindings && (
        <div className={styles.bindPopover}>
          <div className={styles.bindHead}>
            {t("roleplay.band.boundList", { n: boundCount, defaultValue: `本次对话注入的设定 · ${boundCount}` })}
          </div>
          {boundEntries.length === 0 && (
            <div className={styles.bindEmpty}>{t("roleplay.band.boundNone", { defaultValue: "没有绑定任何设定" })}</div>
          )}
          {boundEntries.map((b) => (
            <div key={b.raw} className={`${styles.bindRow} ${b.gone ? styles.bindRowGone : ""}`}>
              <span className={b.gone ? styles.bindDotGone : styles.bindDot} />
              <span className={styles.bindLabel}>{b.label}</span>
              {b.gone && <span className={styles.bindGoneTag}>{t("roleplay.band.deleted", { defaultValue: "已删除" })}</span>}
            </div>
          ))}
        </div>
      )}

      {stale[agent.id] && (
        <div className={styles.staleBar}>
          <span className={styles.staleDot} />
          <span className={styles.staleText}>
            {t("roleplay.stale.body", { defaultValue: "绑定的设定被改过，本次对话用的还是旧版本。" })}
          </span>
          <div className={styles.spacer} />
          <button type="button" className={styles.staleBtn} onClick={() => void refreshBinding(agent.id)}>
            {t("roleplay.stale.refresh", { defaultValue: "刷新设定" })}
          </button>
        </div>
      )}

      {/* ── 稿面 ── */}
      <div className={styles.scroll} ref={scrollRef}>
        <div className={styles.column}>
          {/* 「这一场之前还有几场」。放在稿面最上方而不是信息带里，因为它讲的
              正是这个位置的事——再往上就没有了。 */}
          {archives.length > 0 && (
            <button
              type="button"
              className={styles.archiveBar}
              onClick={() => setShowArchive(true)}
            >
              {t("roleplay.archive.bar", {
                n: archives.length,
                defaultValue: `此前已封存 ${archives.length} 场`,
              })}
              <span className={styles.archiveOpen}>
                {t("roleplay.archive.view", { defaultValue: "查看" })}
              </span>
            </button>
          )}
          {(session?.turns.length ?? 0) === 0 && !isRunning && (
            <div className={styles.chatEmpty}>
              <div className={styles.chatEmptyTitle}>
                {t("roleplay.chatEmpty.title", { name: agent.name, defaultValue: `${agent.name}在这里，还没有人开口。` })}
              </div>
              <div className={styles.chatEmptyBody}>
                {t("roleplay.chatEmpty.body", {
                  n: boundCount,
                  defaultValue: `用一个动作或一句台词起头。TA 只知道你绑给 TA 的 ${boundCount} 项设定，不知道别的角色说过什么。`,
                })}
              </div>
              <div className={styles.starters}>
                {["*我推开门。*", "「你还在等？」", "[从头开始]"].map((s) => (
                  <button key={s} type="button" className={styles.starter} onClick={() => setDraft(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {session?.turns.map((turn) => (
            <TurnBlock
              key={turn.index}
              turn={turn}
              memories={memoriesByTurn.get(turn.index)}
              onRewind={
                turn.speaker === "author" && !isRunning && queuePos < 0
                  && turn.index < (session?.turns.length ?? 0)
                  ? () => setRewindTo(turn.index)
                  : undefined
              }
              log={
                session.log[turn.index]?.length ? (
                  <div className={styles.logLine}>
                    <button
                      type="button"
                      className={styles.logToggle}
                      onClick={() => setOpenLog(openLog === turn.index ? null : turn.index)}
                    >
                      <ChevronRight
                        size={8}
                        strokeWidth={2.6}
                        style={{ transform: openLog === turn.index ? "rotate(90deg)" : undefined }}
                      />
                      {t("roleplay.log.line", {
                        n: session.log[turn.index].filter((e) => e.kind === "tool-step").length,
                        defaultValue: `执行日志 · ${session.log[turn.index].filter((e) => e.kind === "tool-step").length} 步`,
                      })}
                    </button>
                    {openLog === turn.index && (
                      <div className={styles.logBody}><AgentLog log={session.log[turn.index]} isRunning={false} compact /></div>
                    )}
                  </div>
                ) : undefined
              }
            />
          ))}

          {isRunning && (
            <div className={styles.agentTurn}>
              <div className={styles.streamHead}>
                <span className={styles.agentLabel}>{agent.name}</span>
                <span className={styles.streamDot} />
                <span className={styles.streamTime}>
                  {t("roleplay.generating", { s: seconds.toFixed(1), defaultValue: `生成中 · ${seconds.toFixed(1)}s` })}
                </span>
              </div>
              <ScriptText text={session?.streaming ?? ""} caret />
            </div>
          )}

          {queuePos >= 0 && (
            <div className={styles.queueCard}>
              <span className={styles.spinner} />
              <span className={styles.queueText}>
                {t("roleplay.queue.waiting", { n: queuePos, defaultValue: `排队中 · 前面还有 ${queuePos} 个` })}
              </span>
              <span className={styles.queueHint}>
                {t("roleplay.queue.hint", { defaultValue: "同时最多 3 个 agent 生成" })}
              </span>
              <div className={styles.spacer} />
              <button type="button" className={styles.queueBtn} onClick={() => dequeue(agent.id)}>
                {t("roleplay.queue.cancel", { defaultValue: "取消排队" })}
              </button>
              <button type="button" className={styles.queueBtnAccent} onClick={() => promote(agent.id)}>
                {t("roleplay.queue.promote", { defaultValue: "插到最前" })}
              </button>
            </div>
          )}

          {/* 回退的确认。用 transcript 里的原话做提示——作者要撤销的是**这一句**
              和它之后的一切，而那一句自己是最准确的说明。 */}
          {rewindTo !== null && (
            <div className={styles.rewindBar}>
              <span className={styles.rewindText}>
                {t("roleplay.rewind.confirm", {
                  n: (session?.turns.length ?? 0) - rewindTo + 1,
                  defaultValue: `撤销这一句和它之后的 ${(session?.turns.length ?? 0) - rewindTo + 1} 条记录，原文回到输入框。这一段之后记下的事也会一并撤销。`,
                })}
              </span>
              <button
                type="button"
                className={styles.rewindCancel}
                onClick={() => setRewindTo(null)}
              >
                {t("common.cancel", { defaultValue: "取消" })}
              </button>
              <button
                type="button"
                className={styles.rewindGo}
                onClick={() => {
                  const at = rewindTo;
                  setRewindTo(null);
                  void rewind(agent.id, at).then((text) => {
                    if (text === null) return;
                    setDraft(text);
                    taRef.current?.focus();
                  });
                }}
              >
                {t("roleplay.rewind.go", { defaultValue: "回退" })}
              </button>
            </div>
          )}

          {/* 报错 = 这一轮没有回复。作者轮已经在 transcript 里了，所以「重试」是
              接着那一问再跑一次，不是重新说一遍话。 */}
          {/* 按停之后这一问仍孤零零留在 transcript 里，却没有回复——和报错的后果
              一样，所以通向同一个 retry。用比错误带更轻的一行：它不是出了问题，
              是作者自己按的。 */}
          {session?.stopped && !session.error && session.lastJob && !isRunning && queuePos < 0 && (
            <div className={styles.stoppedBar}>
              <span className={styles.stoppedText}>
                {t("roleplay.stopped", { defaultValue: "已停止，这一问还没有回复" })}
              </span>
              <button
                type="button"
                className={styles.errorRetry}
                onClick={() => retry(agent.id)}
              >
                <RotateCw size={11} strokeWidth={2} />
                {t("roleplay.retry", { defaultValue: "重试" })}
              </button>
            </div>
          )}

          {session?.error && (
            <div className={styles.errorBar}>
              <span className={styles.errorText}>{session.error}</span>
              {session.lastJob && !isRunning && queuePos < 0 && (
                <button
                  type="button"
                  className={styles.errorRetry}
                  onClick={() => retry(agent.id)}
                >
                  <RotateCw size={11} strokeWidth={2} />
                  {t("roleplay.retry", { defaultValue: "重试" })}
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 阻塞中的卡片：紧挨着输入框，因为它们是「现在轮到你」的东西。
          旁白改稿的确认卡就落在这里——没有它，旁白最重要的那条能力走不通。 */}
      {(approvals.length > 0 || roundLimits.length > 0 || truncations.length > 0) && (
        <div className={styles.approvals}>
          {approvals.map((p) => <ApprovalCard key={p.proposal.id} item={p} />)}
          {roundLimits.map((p) => <RoundLimitCard key={p.id} item={p} />)}
          {truncations.map((p) => <TruncationCard key={p.id} item={p} />)}
        </div>
      )}

      {/* ── 输入区 ── */}
      <div className={styles.composer}>
        <div className={styles.composerHead}>
          {agent.kind === "narrator" ? (
            <span className={styles.personaHint}>
              {t("roleplay.persona.narratorNote", { defaultValue: "旁白不扮演任何人 · 无身份设定" })}
            </span>
          ) : (
            <PersonaChip agent={agent} />
          )}
          <div className={styles.spacer} />
          {showSyntax ? (
            <button
              type="button"
              className={styles.syntaxToggle}
              onClick={() => { setShowSyntax(false); writePref("app:roleplaySyntaxSeen", "1"); }}
            >
              {t("roleplay.syntax.collapse", { defaultValue: "收起，只留一行" })}
            </button>
          ) : (
            <>
              <span className={styles.syntaxRow}>
                <span className={styles.syntaxAction}>*{t("roleplay.syntax.action", { defaultValue: "动作" })}*</span>
                <span className={styles.syntaxSpeech}>「{t("roleplay.syntax.speech", { defaultValue: "台词" })}」</span>
                <span className={styles.syntaxScene}>{t("roleplay.syntax.scene", { defaultValue: "裸文本＝场景" })}</span>
                <span className={styles.syntaxMeta}>[{t("roleplay.syntax.meta", { defaultValue: "元指令" })}]</span>
              </span>
              <button type="button" className={styles.syntaxToggle} onClick={() => setShowSyntax(true)}>
                {t("roleplay.syntax.expand", { defaultValue: "展开" })}
              </button>
            </>
          )}
        </div>

        {showSyntax && (
          <div className={styles.syntaxCard}>
            <div className={styles.syntaxGrid}>
              {[
                ["*…*", t("roleplay.syntax.action", { defaultValue: "动作" }), "*他没有回头。*"],
                ["「…」", t("roleplay.syntax.speech", { defaultValue: "台词" }), "「你还在等？」"],
                [t("roleplay.syntax.bare", { defaultValue: "裸文本" }), t("roleplay.syntax.scene", { defaultValue: "场景" }), "屋里没有点灯。"],
                ["[…]", t("roleplay.syntax.meta", { defaultValue: "出戏指令" }), "[让他更冷一点]"],
              ].map(([mark, name, example]) => (
                <div key={mark} className={styles.syntaxItem}>
                  <span className={styles.syntaxMark}>{mark}</span>
                  <span className={styles.syntaxName}>{name}</span>
                  <span className={styles.syntaxExample}>{example}</span>
                </div>
              ))}
            </div>
            {/* 引号只在这里说清楚。稿面上 `「」` 是正解，但它在中文输入法下不是
                一个键就能打出来的——不写这一行，作者只会看见最难打的那一种。 */}
            <p className={styles.syntaxNote}>
              {t("roleplay.syntax.quoteNote", {
                defaultValue: "台词的引号 「」 『』 “” \"\" 都认，但开合要同族。中文输入法下 Shift+' 出来的 “” 最省事。",
              })}
            </p>
          </div>
        )}

        <div className={styles.inputBox}>
          <div className={styles.inputStack}>
            {!composing && <ComposerMirror text={draft} innerRef={mirrorRef} />}
            <textarea
              ref={taRef}
              className={`${styles.textarea} ${composing ? styles.textareaVisible : ""}`}
              value={draft}
              rows={3}
              placeholder={
                agent.kind === "narrator"
                  ? t("roleplay.composer.narratorPlaceholder", { defaultValue: "和旁白讨论情节，或让它把某段互动整理进正文…" })
                  : t("roleplay.composer.placeholder", { defaultValue: "说一句台词，或写一个动作…" })
              }
              onChange={(e) => {
                setDraft(e.target.value);
                mention.sync(e.target.value, e.target.selectionStart);
              }}
              onKeyDown={onKeyDown}
              onCompositionStart={() => setComposing(true)}
              onCompositionEnd={() => setComposing(false)}
              onScroll={() => {
                syncMirror();
              }}
            />
          </div>

          {mention.open && (
            <MentionPicker
              anchorRef={taRef}
              items={mentionItems}
              usedKeys={refKeys}
              activeIndex={mention.active}
              preferAbove
              onPick={(item) => void handlePickMention(item)}
              onDismiss={() => { mention.close(); setPickKind(null); }}
            />
          )}

          <ContextBar context={context} />

          {/* 附件行：这条消息**带着什么**（芯片）和这一场**怎么工作**（子代理）。
              原来只有一句「N 项引用」，删不掉任何一项——芯片本身就是删除入口。 */}
          <div className={styles.attachRow}>
            {/* 选区和 `@` 引用并排：两者都是「这条消息带着的材料」，拆成两行会
                读成两套互不相干的机制。 */}
            {quote ? (
              <button
                type="button"
                className={styles.attachChip}
                onClick={() => setDetached(true)}
                title={t("roleplay.composer.detachSelection", { defaultValue: "不附带选区" })}
              >
                {t("roleplay.composer.selectionChip", {
                  n: quote.length, defaultValue: `选区 ${quote.length} 字`,
                })}
                <X size={10} strokeWidth={2} />
              </button>
            ) : selection ? (
              <button
                type="button"
                className={styles.attachGhost}
                onClick={() => setDetached(false)}
              >
                + {t("roleplay.composer.selectionChip", {
                  n: selection.length, defaultValue: `选区 ${selection.length} 字`,
                })}
              </button>
            ) : null}
            {refs.map((r) => {
              const key = attachedKey(r);
              const label = r.kind === "lore" ? r.entity.name : r.file.name;
              return (
                <button
                  key={key}
                  type="button"
                  className={styles.attachChip}
                  onClick={() => setRefs((prev) => prev.filter((x) => attachedKey(x) !== key))}
                  title={t("roleplay.composer.removeRef", { defaultValue: "移除这项引用" })}
                >
                  {/* 图片是唯一一种代价看不出名字的附件——标出它是什么。 */}
                  {r.kind === "image" && <ImageIcon size={10} strokeWidth={2} />}
                  @{label}
                  <X size={10} strokeWidth={2} />
                </button>
              );
            })}
            <span className={styles.attachSpacer} />
            {/* `@` 才是机制本身，这几个按钮只是替作者敲它——它们存在是为了让
                作者发现 `@` 能用，而不是为了取代它。 */}
            <button
              type="button"
              className={styles.attachGhost}
              onClick={() => openMentionFor("lore")}
              disabled={!candidates.some((c) => c.type === "lore")}
            >
              + {t("roleplay.composer.addLore", { defaultValue: "设定" })}
            </button>
            <button
              type="button"
              className={styles.attachGhost}
              onClick={() => openMentionFor("text")}
              disabled={!candidates.some((c) => matchesKind(c, "text"))}
            >
              + {t("roleplay.composer.addDoc", { defaultValue: "文档" })}
            </button>
            {/* 只在这条链看得见图片时出现：纯文本模型上它会是一个永远点不动的
                死芯片。 */}
            {canSeeImages && (
              <button
                type="button"
                className={styles.attachGhost}
                onClick={() => openMentionFor("image")}
                disabled={!candidates.some((c) => matchesKind(c, "image"))}
              >
                + {t("roleplay.composer.addImage", { defaultValue: "图片" })}
              </button>
            )}
            <SubAgentChips
              disabled={disabledSubs}
              onToggle={(kind) => toggleSubAgent(agent.id, kind)}
            />
          </div>

          {refError && <div className={styles.refError}>{refError}</div>}

          <div className={styles.inputFoot}>
            {/* 插入而不是发送：片段是个开头，作者补完再发。 */}
            <SnippetPicker
              onPick={(c) => setDraft((prev) => (prev.trim() ? `${prev}\n${c}` : c))}
            />
            <span className={styles.kbd}>{t("roleplay.composer.newline", { defaultValue: "⇧↵ 换行" })}</span>
            <div className={styles.spacer} />
            {isRunning && (
              <button type="button" className={styles.stopBtn} onClick={() => stop(agent.id)}>
                {t("roleplay.composer.stop", { defaultValue: "停止生成" })}
              </button>
            )}
            <button
              type="button"
              className={styles.sendBtn}
              onClick={doSend}
              disabled={!canSend}
            >
              {t("roleplay.composer.send", { defaultValue: "发送" })}
            </button>
          </div>
        </div>
      </div>
      </div>
      {showArchive && archives.length > 0 && (
        <ArchiveViewer
          scenes={archives}
          agentName={agent.name}
          onClose={() => setShowArchive(false)}
        />
      )}

      {showMemory && (
        <MemoryPanel agentId={agent.id} onClose={() => setShowMemory(false)} onJump={jumpToTurn} />
      )}
    </div>
  );
}

/** 「我此刻是」——作者的身份，全局设置，每个 agent 都看得到。 */
/**
 * 「我此刻是谁」。
 *
 * 两级：全局一个，每个 agent 可以覆盖——作者不一定用同一个身份面对所有角色，
 * 对甲是「桐谷萤」，对乙可能是「一个陌生人」。`runJob` 一直读的就是
 * `agent.authorPersona ?? 全局`，这里只是把入口补上。
 *
 * 菜单顶部先选**作用域**再选人，而不是让两级挤在一张列表里：「这一次改的是
 * 谁」是作者按下之前必须知道的事，事后从高亮上反推太晚了。
 */
function PersonaChip({ agent }: { agent: RoleplayAgent }) {
  const { t } = useTranslation();
  const { authorPersona, setAuthorPersona, setAgentPersona } = useRoleplayStore();
  const loreIndex = useLoreStore((s) => s.index);
  const [open, setOpen] = useState(false);
  const overridden = agent.authorPersona !== null;
  const [scopeAgent, setScopeAgent] = useState(overridden);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  // 打开时把作用域重置成当前实际生效的那一档，而不是留着上次的选择。
  useEffect(() => { if (open) setScopeAgent(overridden); }, [open, overridden]);

  const characters = Object.values(loreIndex).flat();
  /** 实际生效的那一个——和 runJob 的取法必须一致。 */
  const effective = agent.authorPersona ?? authorPersona;
  /** 正在被编辑的那一档（可能不是生效的那一档）。 */
  const editing = scopeAgent ? (agent.authorPersona ?? authorPersona) : authorPersona;

  const nameOf = (p: AuthorPersona) => p.mode === "none"
    ? t("roleplay.persona.none", { defaultValue: "不设定" })
    : p.mode === "prompt"
      ? t("roleplay.persona.custom", { defaultValue: "自定义身份" })
      : characters.find((e) => e.dirPath === p.dirPath)?.name
        ?? t("roleplay.persona.none", { defaultValue: "不设定" });

  const apply = (p: AuthorPersona) => {
    if (scopeAgent) void setAgentPersona(agent.id, p);
    else void setAuthorPersona(p);
    setOpen(false);
  };

  return (
    <div className={styles.personaWrap} ref={ref}>
      <span className={styles.personaLabel}>{t("roleplay.persona.iam", { defaultValue: "我此刻是" })}</span>
      <button type="button" className={styles.personaChip} onClick={() => setOpen((v) => !v)}>
        {nameOf(effective)}
        {/* 只在被覆盖时出现：没有覆盖是常态，常态不需要标记。 */}
        {overridden && (
          <span className={styles.personaOnly}>
            {t("roleplay.persona.onlyHere", { defaultValue: "仅此角色" })}
          </span>
        )}
        <ChevronDown size={8} strokeWidth={2.6} />
      </button>
      {open && (
        <div className={styles.personaMenu}>
          <div className={styles.personaScope}>
            <button
              type="button"
              className={`${styles.scopeTab} ${!scopeAgent ? styles.scopeTabOn : ""}`}
              onClick={() => setScopeAgent(false)}
            >
              {t("roleplay.persona.scopeAll", { defaultValue: "全部对话" })}
            </button>
            <button
              type="button"
              className={`${styles.scopeTab} ${scopeAgent ? styles.scopeTabOn : ""}`}
              onClick={() => setScopeAgent(true)}
            >
              {t("roleplay.persona.scopeOne", { name: agent.name, defaultValue: `只对 ${agent.name}` })}
            </button>
          </div>
          <button
            type="button"
            className={`${styles.personaItem} ${editing.mode === "none" ? styles.personaItemActive : ""}`}
            onClick={() => apply({ mode: "none", dirPath: null, prompt: "" })}
          >
            <span className={styles.radio} />
            {t("roleplay.persona.none", { defaultValue: "不设定" })}
            <span className={styles.personaNote}>{t("roleplay.persona.noneHint", { defaultValue: "以旁观者身份说话" })}</span>
          </button>
          {characters.map((e) => (
            <button
              key={e.dirPath}
              type="button"
              className={`${styles.personaItem} ${editing.dirPath === e.dirPath ? styles.personaItemActive : ""}`}
              onClick={() => apply({ mode: "lore", dirPath: e.dirPath, prompt: "" })}
            >
              <span className={styles.radio} />
              {e.name}
            </button>
          ))}
          {/* 撤销覆盖的入口就在做出覆盖的地方——和模型选择器的「跟随全局设置」
              同一条道理（§2.14）。 */}
          {overridden && (
            <button
              type="button"
              className={styles.personaFollow}
              onClick={() => { void setAgentPersona(agent.id, null); setOpen(false); }}
            >
              {t("roleplay.persona.follow", {
                name: nameOf(authorPersona),
                defaultValue: `跟随全局设置（${nameOf(authorPersona)}）`,
              })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
