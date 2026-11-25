import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp, Folder, FolderOpen, Images, RotateCcw, ScanText, Trash2 } from "lucide-react";
import { toast, Toaster } from "sonner";
import { loadDir, rememberDir } from "@/lib/folder";
import { inspect, readOriginalTime, stamp, timeProblem } from "@/lib/stamp/index";
import { batchStamp, computePlan, formatClock, type Plan } from "@/lib/timeplan";
import { readStealth, readTextMeta } from "@/lib/nai/read";
import { ExportSheet } from "./ExportSheet";
import { Grid } from "./Grid";
import { Lightbox } from "./Lightbox";
import { MetaView } from "./MetaView";
import { MAX_PHOTOS, type Photo } from "./types";

type Problem = { id: string; name: string; thumb: string; reason: string };

type Round = {
  prefix: string;
  photos: Photo[];
  times: number[];
  dir: FileSystemDirectoryHandle;
  next: number;
  verified: number;
  lastName: string | null;
  lastTime: number | null;
  strict: boolean;
};

export function Studio() {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [reading, setReading] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [origin, setOrigin] = useState<DOMRect | null>(null);
  const [sheet, setSheet] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [blocked, setBlocked] = useState<Problem[] | null>(null);
  const [askClear, setAskClear] = useState(false);
  const [barOpen, setBarOpen] = useState(true);
  const [folderName, setFolderName] = useState<string | null>(null);
  const [pause, setPause] = useState<{ number: number; name: string; reason: string } | null>(null);
  const [readOn, setReadOn] = useState(false);
  const [view, setView] = useState<"light" | "meta">("light");
  const [zoom, setZoom] = useState(false);
  const seq = useRef(0);
  const photosRef = useRef(photos);
  photosRef.current = photos;
  const cancelSave = useRef(false);
  const saving = useRef(false);
  const folderRef = useRef<FileSystemDirectoryHandle | null>(null);
  const roundRef = useRef<Round | null>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const readOnRef = useRef(false);
  readOnRef.current = readOn;
  const showGen = useRef(0);

  useEffect(() => {
    void loadDir()
      .then((dir) => {
        if (!dir) return;
        folderRef.current = dir;
        setFolderName(dir.name);
      })
      .catch(() => {});
  }, []);

  async function addFiles(list: FileList | null) {
    if (!list || !list.length || reading || progress || saving.current) return;
    const files = [...list];
    const prepared: Photo[] = [];
    let skipped = 0;
    for (let index = 0; index < files.length; index += 1) {
      setReading(`正在读取 ${index + 1}/${files.length}`);
      const file = files[index];
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const info = inspect(bytes);
        if (!info.image) {
          skipped += 1;
          continue;
        }
        let thumb = "";
        try {
          thumb = await makeThumb(file);
        } catch {
          thumb = "";
        }
        prepared.push({
          id: crypto.randomUUID(),
          name: file.name || "未命名",
          file,
          thumb,
          originalTime: readOriginalTime(bytes, file.lastModified || Date.now()),
          seq: seq.current++,
          reason: info.ok ? null : info.reason,
          ext: info.ok ? (info.kind === "jpeg" ? "jpg" : info.kind) : "jpg",
          meta: readOnRef.current ? readTextMeta(bytes) : undefined,
        });
      } catch {
        skipped += 1;
      }
    }
    prepared.reverse();
    const prev = photosRef.current;
    const room = Math.max(0, MAX_PHOTOS - prev.length);
    const take = prepared.slice(0, room);
    const dropped = prepared.length - take.length;
    setPhotos([...take, ...prev]);
    if (prev.length >= MAX_PHOTOS && prepared.length) toast(`已经有 ${MAX_PHOTOS} 张，先去掉一些再加`);
    else if (dropped) toast(`只加入了 ${take.length} 张，有 ${dropped} 张因为超过 ${MAX_PHOTOS} 张没有加入`);
    if (skipped) toast(`跳过了 ${skipped} 个不是图片的文件`);
    setReading(null);
  }

  function resetOrder() {
    setPhotos((prev) => [...prev].sort((a, b) => b.originalTime - a.originalTime || a.seq - b.seq));
    toast("已恢复成按原来的时间排列");
  }

  function remove(id: string) {
    if (saving.current) return;
    const prev = photosRef.current;
    const index = prev.findIndex((photo) => photo.id === id);
    const next = prev.filter((photo) => photo.id !== id);
    photosRef.current = next;
    setPhotos(next);
    if (openId !== id) return;
    if (!next.length) {
      setOpenId(null);
      setZoom(false);
      return;
    }
    void showPhoto(next[Math.min(Math.max(index, 0), next.length - 1)].id);
  }

  async function showPhoto(id: string) {
    const gen = ++showGen.current;
    const photo = photosRef.current.find((item) => item.id === id);
    if (!photo) return;
    setOpenId(id);
    if (!readOnRef.current) {
      setView("light");
      setZoom(false);
      return;
    }
    let meta = photo.meta;
    if (meta === undefined) {
      const bytes = new Uint8Array(await photo.file.arrayBuffer());
      if (gen !== showGen.current) return;
      meta = readTextMeta(bytes);
      setPhotos((prev) => prev.map((item) => (item.id === id ? { ...item, meta } : item)));
    }
    if (meta) {
      setView("meta");
      return;
    }
    if (photo.stealth) {
      setView("light");
      setZoom(false);
      return;
    }
    setView("light");
    const found = await readStealth(photo.file);
    if (gen !== showGen.current) return;
    setPhotos((prev) => prev.map((item) => (item.id === id ? { ...item, meta: found, stealth: true } : item)));
    if (!found) setZoom(false);
    setView(found ? "meta" : "light");
  }

  function toggleRead() {
    setReadOn((on) => {
      if (on) return false;
      void fillText();
      return true;
    });
  }

  async function fillText() {
    const current = photosRef.current.filter((photo) => photo.meta === undefined);
    if (!current.length) return;
    const updates = new Map<string, ReturnType<typeof readTextMeta>>();
    for (const photo of current) {
      const bytes = new Uint8Array(await photo.file.arrayBuffer());
      updates.set(photo.id, readTextMeta(bytes));
    }
    setPhotos((prev) => prev.map((photo) => (updates.has(photo.id) ? { ...photo, meta: updates.get(photo.id) ?? null } : photo)));
  }

  async function exportPlan(plan: Plan, strict: boolean) {
    if (saving.current || roundRef.current) return;
    saving.current = true;
    cancelSave.current = false;
    const snapshot = photos.slice();
    const total = snapshot.length;
    setProgress({ done: 0, total });
    try {
      const dir = await readyDir(folderRef.current);
      folderRef.current = dir;
      setFolderName(dir.name);
      await rememberDir(dir).catch(() => {});
      const problems = await preflight(snapshot);
      if (problems.length) {
        setProgress(null);
        setSheet(false);
        setBlocked(problems);
        saving.current = false;
        return;
      }
      let active = plan;
      if (plan.usesNow) {
        const now = Date.now();
        const fresh = computePlan({
          n: snapshot.length,
          now,
          owned: plan.autoInterval ? [] : ["interval"],
          startMs: null,
          endMs: null,
          intervalMs: plan.autoInterval ? null : plan.intervalMs,
        });
        if (fresh.error) throw new Error(fresh.error);
        active = fresh;
      }
      roundRef.current = {
        prefix: batchStamp(Date.now()),
        photos: snapshot,
        times: active.times,
        dir,
        next: total - 1,
        verified: 0,
        lastName: null,
        lastTime: null,
        strict,
      };
      await runRound();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setProgress(null);
        saving.current = false;
        return;
      }
      setProgress(null);
      setSheet(false);
      saving.current = false;
      notify(false, error instanceof Error ? error.message : "没能开始保存");
    }
  }

  async function runRound() {
    const round = roundRef.current;
    if (!round) return;
    const total = round.photos.length;
    while (round.next >= 0) {
      if (cancelSave.current) {
        endRound();
        return;
      }
      const index = round.next;
      const photo = round.photos[index];
      const number = total - index;
      const filename = `ord_${round.prefix}_${pad(number)}.${photo.ext}`;
      try {
        if (round.lastName) await previousStillThere(round.dir, round.lastName, number);
        const bytes = new Uint8Array(await photo.file.arrayBuffer());
        const stamped = stamp(bytes, round.times[index]);
        const saved = await putFile(round.dir, filename, stamped);
        const planned = round.times[index];
        const written = await timeOf(saved, planned);
        if (written !== planned) throw new Error(`时间不对，应该是 ${clock(planned)}，写成了 ${clock(written)}`);
        if (round.lastTime != null) {
          const gap = written - round.lastTime;
          const expected = planned - round.times[index + 1];
          if (gap !== expected) throw new Error(`间隔不对，和上一张差了 ${seconds(gap)} 秒，应该差 ${seconds(expected)} 秒`);
        }
        round.lastName = filename;
        round.lastTime = written;
        round.verified += 1;
        round.next = index - 1;
        setProgress({ done: round.verified, total });
        if (round.strict && round.next >= 0) await sleep(1000);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "没能写入";
        setProgress(null);
        setSheet(false);
        setPause({ number, name: photo.name, reason });
        return;
      }
    }
    const problem = await auditTimes(round);
    if (problem) {
      round.next = problem.index;
      if (problem.index + 1 < total) {
        const prev = round.photos[problem.index + 1];
        round.lastName = `ord_${round.prefix}_${pad(total - problem.index - 1)}.${prev.ext}`;
        round.lastTime = round.times[problem.index + 1];
      } else {
        round.lastName = null;
        round.lastTime = null;
      }
      setProgress(null);
      setSheet(false);
      setPause({ number: total - problem.index, name: round.photos[problem.index].name, reason: problem.reason });
      return;
    }
    setProgress(null);
    setSheet(false);
    roundRef.current = null;
    saving.current = false;
    cancelSave.current = false;
    if (round.verified === total) notify(true, `这一轮 ${total} 张，时间间隔也对`);
    else notify(false, `这一轮只确认了 ${round.verified} 张，操作区是 ${total} 张`);
  }

  function endRound() {
    const round = roundRef.current;
    const verified = round?.verified ?? 0;
    const total = round?.photos.length ?? 0;
    setPause(null);
    setProgress(null);
    setSheet(false);
    roundRef.current = null;
    saving.current = false;
    cancelSave.current = false;
    notify(false, `这一轮只确认了 ${verified} 张，操作区是 ${total} 张`);
  }

  function retryRound() {
    if (!roundRef.current || !saving.current) return;
    cancelSave.current = false;
    setPause(null);
    setSheet(true);
    setProgress({ done: roundRef.current.verified, total: roundRef.current.photos.length });
    void runRound();
  }

  async function pickFolder() {
    if (saving.current) return;
    try {
      const dir = await chooseDir();
      folderRef.current = dir;
      setFolderName(dir.name);
      await rememberDir(dir).catch(() => {});
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      notify(false, error instanceof Error ? error.message : "没能选中文件夹");
    }
  }

  return (
    <main className="fixed inset-0 overflow-hidden bg-bg text-fg">
      <Toaster position="top-center" />
      <div className="mx-auto flex h-full w-full max-w-md flex-col">
        <header className="shrink-0 px-4 pt-safe">
          {barOpen ? (
            <div className="flex h-11 items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-1.5">
                <h1 className="shrink-0 font-serif text-xl leading-none">时序</h1>
                <p className="truncate text-sm text-muted">{reading ?? `${photos.length} 张`}</p>
                <button type="button" aria-label="收起" className="flex h-7 w-7 shrink-0 items-center justify-center text-fg" onClick={() => setBarOpen(false)}>
                  <ChevronUp size={18} strokeWidth={1.75} />
                </button>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  className="flex h-11 items-center gap-1 rounded-full bg-fg px-3 text-sm text-primary-fg disabled:opacity-40"
                  disabled={!!reading || !!progress || !!pause}
                  onClick={() => photoInput.current?.click()}
                >
                  <Images size={16} strokeWidth={1.75} />
                  照片
                </button>
                <button
                  type="button"
                  className="flex h-11 items-center gap-1 rounded-full px-3 text-sm ring-1 ring-line disabled:opacity-40"
                  disabled={!!reading || !!progress || !!pause}
                  onClick={() => fileInput.current?.click()}
                >
                  <FolderOpen size={16} strokeWidth={1.75} />
                  文件
                </button>
              </div>
            </div>
          ) : (
            <div className="flex h-5 items-center">
              <p className="text-sm leading-5 text-muted">{reading ?? `${photos.length} 张`}</p>
              <button type="button" aria-label="展开" className="flex h-5 w-5 items-center justify-center text-fg" onClick={() => setBarOpen(true)}>
                <ChevronDown size={16} strokeWidth={1.75} />
              </button>
            </div>
          )}
        </header>
        {photos.length === 0 ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-8 text-center">
            <p className="text-lg">先把图片加进来</p>
            <p className="mt-2 text-sm leading-6 text-muted">
              新的在左上。长按拖动排序，点一下看大图。图片只留在这次打开里，刷新会清空。
            </p>
          </div>
        ) : (
          <Grid
            photos={photos}
            onOpen={(id, rect) => {
              setOrigin(rect);
              setZoom(false);
              void showPhoto(id);
            }}
            onReorder={(from, to) => {
              if (saving.current) return;
              setPhotos((prev) => {
                const next = prev.slice();
                const [item] = next.splice(from, 1);
                if (!item) return prev;
                next.splice(to, 0, item);
                return next;
              });
            }}
          />
        )}
        <footer className="flex shrink-0 items-center gap-1 border-t border-line px-2 pt-3 pb-safe">
          <button type="button" className="flex h-12 w-11 shrink-0 flex-col items-center justify-center gap-0.5 text-[11px] disabled:opacity-40" disabled={!photos.length || !!progress || !!pause} onClick={resetOrder}>
            <RotateCcw size={18} strokeWidth={1.75} />
            重置
          </button>
          <button type="button" className="flex h-12 w-11 shrink-0 flex-col items-center justify-center gap-0.5 text-[11px] disabled:opacity-40" disabled={!photos.length || !!progress || !!pause} onClick={() => setAskClear(true)}>
            <Trash2 size={18} strokeWidth={1.75} />
            清空
          </button>
          <button
            type="button"
            className={`flex h-12 w-11 shrink-0 flex-col items-center justify-center gap-0.5 rounded-xl text-[11px] ${readOn ? "bg-fg text-primary-fg" : ""}`}
            onClick={toggleRead}
          >
            <ScanText size={18} strokeWidth={1.75} />
            读参
          </button>
          <button
            type="button"
            className="ml-auto flex h-12 w-14 shrink-0 flex-col items-center justify-center gap-0.5 text-[11px] disabled:opacity-40"
            disabled={!!progress || !!pause}
            onClick={() => void pickFolder()}
          >
            <Folder size={18} strokeWidth={1.75} />
            <span className="w-full truncate text-center">{folderName ?? "文件夹"}</span>
          </button>
          <button
            type="button"
            className="h-12 w-20 shrink-0 rounded-2xl bg-primary text-sm text-primary-fg disabled:opacity-40"
            disabled={!photos.length || !!reading || !!progress || !!pause}
            onClick={() => setSheet(true)}
          >
            输出
          </button>
        </footer>
      </div>
      <input
        ref={photoInput}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(event) => {
          void addFiles(event.target.files);
          event.target.value = "";
        }}
      />
      <input
        ref={fileInput}
        type="file"
        accept="image/*,.jpg,.jpeg,.png,.webp,.gif,.heic,.heif,.bmp,.avif,application/octet-stream"
        multiple
        className="hidden"
        onChange={(event) => {
          void addFiles(event.target.files);
          event.target.value = "";
        }}
      />
      {openId && view === "meta" && photos.find((photo) => photo.id === openId)?.meta ? (
        <MetaView
          photos={photos}
          photoId={openId}
          info={photos.find((photo) => photo.id === openId)!.meta!}
          onClose={() => {
            setZoom(false);
            setOpenId(null);
          }}
          onChange={(id) => {
            setOrigin(null);
            setZoom(false);
            void showPhoto(id);
          }}
          onDelete={remove}
          onZoom={() => setZoom(true)}
        />
      ) : null}
      {openId && (view !== "meta" || zoom || !photos.find((photo) => photo.id === openId)?.meta) ? (
        <Lightbox
          photos={photos}
          photoId={openId}
          origin={origin}
          onClose={() => {
            if (zoom && view === "meta") setZoom(false);
            else setOpenId(null);
          }}
          onChange={(id) => {
            setOrigin(null);
            void showPhoto(id);
          }}
          onDelete={remove}
        />
      ) : null}
      <ExportSheet
        open={sheet}
        photos={photos}
        progress={progress}
        onClose={() => setSheet(false)}
        onConfirm={(plan, strict) => void exportPlan(plan, strict)}
        onStop={() => {
          cancelSave.current = true;
        }}
      />
      {blocked ? (
        <Modal title="先不保存" onClose={() => setBlocked(null)}>
          <p className="text-sm leading-6 text-muted">有 {blocked.length} 张写不了时间。去掉之后再输出。还没开始保存。</p>
          <ul className="mt-3 max-h-64 overflow-y-auto">
            {blocked.map((item) => (
              <li key={item.id} className="flex items-center gap-3 border-t border-line py-2">
                {item.thumb ? <img src={item.thumb} alt="" className="h-12 w-12 rounded-md object-contain bg-bg" /> : <span className="h-12 w-12 rounded-md bg-bg" />}
                <span className="min-w-0">
                  <span className="block truncate text-sm">{item.name}</span>
                  <span className="block text-sm text-primary">{item.reason}</span>
                </span>
              </li>
            ))}
          </ul>
        </Modal>
      ) : null}
      {pause ? (
        <Modal title="保存停了" onClose={() => {}} dismiss={false}>
          <p className="text-sm leading-6 text-muted">
            停在第 {pad(pause.number)} 张{pause.name ? `「${pause.name}」` : ""}。{pause.reason}。点重试会从这一张接着写，还是这一轮。
          </p>
          <div className="mt-5 flex gap-3">
            <button type="button" className="h-11 flex-1 rounded-2xl ring-1 ring-line" onClick={endRound}>
              结束本轮
            </button>
            <button type="button" className="h-11 flex-1 rounded-2xl bg-primary text-primary-fg" onClick={retryRound}>
              重试
            </button>
          </div>
        </Modal>
      ) : null}
      {askClear ? (
        <Modal title="清空列表？" onClose={() => setAskClear(false)} dismiss={false}>
          <p className="text-sm text-muted">手机里的原图不会删除。</p>
          <div className="mt-5 flex gap-3">
            <button type="button" className="h-11 flex-1 rounded-2xl ring-1 ring-line" onClick={() => setAskClear(false)}>
              取消
            </button>
            <button
              type="button"
              className="h-11 flex-1 rounded-2xl bg-primary text-primary-fg"
              onClick={() => {
                setPhotos([]);
                setOpenId(null);
                setAskClear(false);
              }}
            >
              清空
            </button>
          </div>
        </Modal>
      ) : null}
    </main>
  );
}

function Modal({
  title,
  onClose,
  children,
  dismiss = true,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  dismiss?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-fg/40 px-5">
      <div className="w-full max-w-sm rounded-card bg-surface p-5 text-fg shadow-lg">
        <h2 className="text-xl font-medium">{title}</h2>
        <div className="mt-3">{children}</div>
        {dismiss ? (
          <button type="button" className="mt-5 h-11 w-full rounded-2xl bg-primary text-primary-fg" onClick={onClose}>
            知道了
          </button>
        ) : null}
      </div>
    </div>
  );
}

function pad(number: number): string {
  return String(number).padStart(3, "0");
}

function serial(name: string): number | null {
  const match = /_(\d+)\.[^.]+$/.exec(name);
  return match ? Number(match[1]) : null;
}

function notify(ok: boolean, text: string) {
  toast.dismiss("round-ok");
  toast.dismiss("round-bad");
  const options = {
    id: ok ? "round-ok" : "round-bad",
    duration: Infinity,
    style: ok
      ? { background: "#e7f6ec", color: "#146c2e", border: "1px solid #146c2e" }
      : { background: "#fdecea", color: "#8c1d18", border: "1px solid #8c1d18" },
  };
  if (ok) toast.success(text, options);
  else toast.error(text, options);
}

async function preflight(list: Photo[]): Promise<Problem[]> {
  const problems: Problem[] = [];
  for (const photo of list) {
    if (photo.reason) {
      problems.push({ id: photo.id, name: photo.name, thumb: photo.thumb, reason: photo.reason });
      continue;
    }
    try {
      const bytes = new Uint8Array(await photo.file.arrayBuffer());
      const info = inspect(bytes);
      if (!info.ok) problems.push({ id: photo.id, name: photo.name, thumb: photo.thumb, reason: info.reason });
    } catch {
      problems.push({ id: photo.id, name: photo.name, thumb: photo.thumb, reason: "文件已损坏" });
    }
  }
  return problems;
}

async function readyDir(saved: FileSystemDirectoryHandle | null): Promise<FileSystemDirectoryHandle> {
  const handle = saved as (FileSystemDirectoryHandle & {
    requestPermission?: (options: { mode: "readwrite" }) => Promise<PermissionState>;
  }) | null;
  if (handle?.requestPermission) {
    try {
      const state = await handle.requestPermission({ mode: "readwrite" });
      if (state === "granted") return handle;
    } catch {
      // 许可失效时改由选择器重新选
    }
  }
  return chooseDir();
}

async function chooseDir(): Promise<FileSystemDirectoryHandle> {
  const pick = (window as Window & {
    showDirectoryPicker?: (options: { mode: "readwrite" }) => Promise<FileSystemDirectoryHandle>;
  }).showDirectoryPicker;
  if (!pick) throw new Error("这个浏览器不能选文件夹，请用 Chrome 打开");
  return pick({ mode: "readwrite" });
}

async function previousStillThere(dir: FileSystemDirectoryHandle, lastName: string, currentNumber: number) {
  const lastNumber = serial(lastName);
  if (lastNumber == null || lastNumber !== currentNumber - 1) {
    throw new Error(`序号不连着，上一张是 ${lastNumber == null ? "未知" : pad(lastNumber)}`);
  }
  try {
    const handle = await dir.getFileHandle(lastName);
    const file = await handle.getFile();
    if (file.name !== lastName || file.size <= 0) throw new Error("上一张在文件夹里对不上");
  } catch (error) {
    if (error instanceof Error && error.message === "上一张在文件夹里对不上") throw error;
    throw new Error("上一张不在文件夹里");
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function putFile(dir: FileSystemDirectoryHandle, filename: string, bytes: Uint8Array): Promise<File> {
  const handle = await dir.getFileHandle(filename, { create: true });
  const writable = await handle.createWritable();
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  await writable.write(copy);
  await writable.close();
  const saved = await handle.getFile();
  const number = serial(filename);
  if (saved.name !== filename || number == null) throw new Error(`序号不对，写出来的是 ${saved.name}`);
  if (saved.size !== bytes.byteLength) throw new Error("大小对不上，这一张不算成功");
  return saved;
}

async function timeOf(file: Blob, planned: number): Promise<number> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const problem = timeProblem(bytes, planned);
  if (problem) throw new Error(problem);
  const ms = readOriginalTime(bytes, Number.NaN);
  if (ms !== planned) throw new Error(`时间不对，应该是 ${clock(planned)}，写成了 ${Number.isFinite(ms) ? clock(ms) : "读不出来"}`);
  return ms;
}

function clock(ms: number): string {
  return formatClock(ms);
}

function seconds(ms: number): string {
  const value = Math.round(ms / 10) / 100;
  return String(value);
}

async function auditTimes(round: Round): Promise<{ index: number; reason: string } | null> {
  let newer: number | null = null;
  for (let index = 0; index < round.photos.length; index += 1) {
    const photo = round.photos[index];
    const filename = `ord_${round.prefix}_${pad(round.photos.length - index)}.${photo.ext}`;
    try {
      const handle = await round.dir.getFileHandle(filename);
      const file = await handle.getFile();
      const written = await timeOf(file, round.times[index]);
      if (written !== round.times[index]) {
        return { index, reason: `时间不对，应该是 ${clock(round.times[index])}，写成了 ${clock(written)}` };
      }
      if (newer != null) {
        const gap = newer - written;
        const expected = round.times[index - 1] - round.times[index];
        if (gap !== expected) {
          return { index, reason: `和第 ${pad(round.photos.length - index + 1)} 张差了 ${seconds(gap)} 秒，应该差 ${seconds(expected)} 秒` };
        }
      }
      newer = written;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "读不出拍摄时间";
      return { index, reason };
    }
  }
  return null;
}

async function makeThumb(file: Blob): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const edge = 240;
  const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    return "";
  }
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.72);
}
