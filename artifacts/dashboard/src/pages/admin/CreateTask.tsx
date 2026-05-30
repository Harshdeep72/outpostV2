import { useState } from "react";
import { post } from "@/lib/api";
import { cn } from "@/lib/utils";

const TYPES = [
  { value: "comment", label: "Reddit Comment" },
  { value: "upvote", label: "Reddit Upvote" },
  { value: "post", label: "Reddit Post" },
  { value: "twitter_like", label: "Twitter Like" },
  { value: "twitter_retweet", label: "Twitter Retweet" },
  { value: "twitter_reply", label: "Twitter Reply" },
  { value: "twitter_follow", label: "Twitter Follow" },
  { value: "quora_upvote", label: "Quora Upvote" },
  { value: "quora_answer", label: "Quora Answer" },
  { value: "quora_follow", label: "Quora Follow" },
];

interface CreateResponse {
  id: number;
  title: string;
  type: string;
  reward: string | number;
  maxSlots: number;
  slotsFilled: number;
  status: string;
  createdAt: string;
}

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 10;

interface MediaItem {
  file: File;
  previewUrl: string;
  isImage: boolean;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.onload = () => {
      // result is a "data:<mime>;base64,<DATA>" string — strip the prefix
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

export default function CreateTask() {
  const [type, setType] = useState("comment");
  const [title, setTitle] = useState("");
  const [link, setLink] = useState("");
  const [instructions, setInstructions] = useState("");
  const [prewrittenComment, setPrewrittenComment] = useState("");
  const [postBody, setPostBody] = useState("");
  const [flair, setFlair] = useState("");
  const [reward, setReward] = useState("0.10");
  // Single tasks are always 1-slot. For multi-slot drops, use the Bulk Tasks page.
  const [timeLimitMinutes, setTimeLimitMinutes] = useState("30");
  const [holdHours, setHoldHours] = useState("168");
  const [minTrustScore, setMinTrustScore] = useState("0");
  const [cooldownEnabled, setCooldownEnabled] = useState(true);
  const [mediaItems, setMediaItems] = useState<MediaItem[]>([]);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState<CreateResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const isPost = type === "post";
  const linkLabel = isPost ? "Subreddit (name or URL)" : "Task Link";
  const linkPlaceholder = isPost
    ? "r/AskReddit (or paste subreddit URL)"
    : "https://reddit.com/r/... or https://x.com/... or https://www.quora.com/...";
  const titleLabel = isPost
    ? "Title (used as Reddit post title)"
    : "Title (optional — auto-generated if blank)";

  const handleFilesAdd = (incoming: FileList | null) => {
    setError("");
    if (!incoming || incoming.length === 0) return;
    const toAdd: MediaItem[] = [];
    const remainingSlots = MAX_FILES - mediaItems.length;
    if (remainingSlots <= 0) {
      setError(`You can attach at most ${MAX_FILES} files per task.`);
      return;
    }
    for (let i = 0; i < incoming.length && toAdd.length < remainingSlots; i++) {
      const file = incoming[i]!;
      const isImage = file.type.startsWith("image/");
      const isVideo = file.type.startsWith("video/");
      if (!isImage && !isVideo) {
        setError(`"${file.name}" is not an image or video.`);
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        setError(`"${file.name}" is too large (max 25 MB per file).`);
        continue;
      }
      toAdd.push({ file, previewUrl: URL.createObjectURL(file), isImage });
    }
    if (incoming.length > remainingSlots) {
      setError(`Only added the first ${remainingSlots} — max ${MAX_FILES} files per task.`);
    }
    if (toAdd.length) setMediaItems([...mediaItems, ...toAdd]);
  };

  const removeMediaAt = (idx: number) => {
    const item = mediaItems[idx];
    if (item) URL.revokeObjectURL(item.previewUrl);
    setMediaItems(mediaItems.filter((_, i) => i !== idx));
  };

  const clearAllMedia = () => {
    mediaItems.forEach((m) => URL.revokeObjectURL(m.previewUrl));
    setMediaItems([]);
  };

  const formatBytes = (n: number): string => {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess(null);
    setLoading(true);
    try {
      const body: Record<string, unknown> = {
        type, title, link, instructions,
        reward: parseFloat(reward),
        slots: 1,
        timeLimitMinutes: parseInt(timeLimitMinutes),
        holdHours: parseInt(holdHours),
        minTrustScore: parseInt(minTrustScore),
        cooldownEnabled,
      };
      if (isPost) {
        body.postBody = postBody;
        if (flair) body.flair = flair;
      } else if (prewrittenComment) {
        body.prewrittenComment = prewrittenComment;
      }
      if (mediaItems.length > 0) {
        // Read all files in parallel — much faster than awaiting one at a time.
        const encoded = await Promise.all(mediaItems.map(async (m) => ({
          base64: await fileToBase64(m.file),
          filename: m.file.name,
          contentType: m.file.type || null,
        })));
        body.mediaItems = encoded;
      }
      const result = await post<CreateResponse>("/admin/tasks/create", body);
      setSuccess(result);
      setTitle("");
      setLink("");
      setInstructions("");
      setPrewrittenComment("");
      setPostBody("");
      setFlair("");
      clearAllMedia();
    } catch (err: any) {
      setError(err.message ?? "Failed to create task");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Create Task</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Posts to your Discord #tasks channel and lets members claim it.
        </p>
      </header>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="rounded-xl border border-border bg-card p-6 space-y-4">
          <Field label="Task Type">
            <select value={type} onChange={e => setType(e.target.value)} className={fieldClass}>
              {TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </Field>

          <Field label={titleLabel}>
            <input
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              className={fieldClass}
              placeholder={isPost ? "Short title (also posted to Reddit)" : "Leave blank for e.g. \"Comment on r/AskReddit\""}
              required={isPost}
              maxLength={100}
            />
          </Field>

          <Field label={linkLabel}>
            <input
              type="text"
              value={link}
              onChange={e => setLink(e.target.value)}
              className={fieldClass}
              placeholder={linkPlaceholder}
              required
            />
          </Field>

          <Field label="Instructions (optional)">
            <textarea
              value={instructions}
              onChange={e => setInstructions(e.target.value)}
              className={cn(fieldClass, "min-h-[100px] resize-y")}
              placeholder="Optional — what exactly should the user do? Leave blank if the link + pre-written content say it all."
              maxLength={1500}
            />
          </Field>

          {isPost ? (
            <>
              <Field label="Post Body">
                <textarea
                  value={postBody}
                  onChange={e => setPostBody(e.target.value)}
                  className={cn(fieldClass, "min-h-[120px] resize-y")}
                  placeholder="The actual content of the post the user will create"
                  required
                  maxLength={4000}
                />
              </Field>
              <Field label="Flair (optional)">
                <input
                  type="text"
                  value={flair}
                  onChange={e => setFlair(e.target.value)}
                  className={fieldClass}
                  placeholder="e.g. Discussion"
                  maxLength={50}
                />
              </Field>
            </>
          ) : (
            <Field label="Prewritten Comment (optional)">
              <textarea
                value={prewrittenComment}
                onChange={e => setPrewrittenComment(e.target.value)}
                className={cn(fieldClass, "min-h-[80px] resize-y")}
                placeholder="If you provide one, users must use this exact text"
                maxLength={2000}
              />
            </Field>
          )}

          <Field label={`Attachments — images & videos (optional, up to ${MAX_FILES} files, 25 MB each)`}>
            <div className="space-y-3">
              <input
                type="file"
                accept="image/*,video/*"
                multiple
                onChange={(e) => { handleFilesAdd(e.target.files); e.currentTarget.value = ""; }}
                disabled={mediaItems.length >= MAX_FILES}
                className="text-sm text-foreground file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-primary-foreground hover:file:bg-primary/90 disabled:opacity-50"
              />
              {mediaItems.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {mediaItems.map((m, idx) => (
                    <div key={idx} className="relative group rounded-md border border-border bg-background p-1.5 flex items-center gap-2">
                      {m.isImage ? (
                        <img src={m.previewUrl} alt={m.file.name} className="h-12 w-12 rounded object-cover" />
                      ) : (
                        <div className="h-12 w-12 rounded bg-secondary flex items-center justify-center text-xs font-semibold text-muted-foreground">
                          VIDEO
                        </div>
                      )}
                      <div className="flex flex-col text-left min-w-0 pr-1">
                        <span className="text-xs text-foreground truncate max-w-[140px]" title={m.file.name}>{m.file.name}</span>
                        <span className="text-[10px] text-muted-foreground">{formatBytes(m.file.size)}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeMediaAt(idx)}
                        className="text-xs text-muted-foreground hover:text-destructive underline ml-1"
                        aria-label={`Remove ${m.file.name}`}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              All files are attached to the Discord task post. The first image becomes the embed preview; videos and extra images attach below as a gallery. {mediaItems.length}/{MAX_FILES} added.
            </p>
          </Field>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <Field label="Reward ($)">
              <input
                type="number"
                step="0.01"
                min="0"
                value={reward}
                onChange={e => setReward(e.target.value)}
                className={fieldClass}
                required
              />
            </Field>
            <Field label="Time Limit (min)">
              <input
                type="number"
                min="5"
                max="1440"
                value={timeLimitMinutes}
                onChange={e => setTimeLimitMinutes(e.target.value)}
                className={fieldClass}
              />
            </Field>
            <Field label="Hold (hours)">
              <input
                type="number"
                min="0"
                max="720"
                value={holdHours}
                onChange={e => setHoldHours(e.target.value)}
                className={fieldClass}
              />
            </Field>
            <Field label="Min Trust Score">
              <input
                type="number"
                min="0"
                max="100"
                value={minTrustScore}
                onChange={e => setMinTrustScore(e.target.value)}
                className={fieldClass}
              />
            </Field>
          </div>

          <label className="flex items-start gap-3 cursor-pointer pt-1">
            <input
              type="checkbox"
              checked={cooldownEnabled}
              onChange={e => setCooldownEnabled(e.target.checked)}
              className="mt-1 h-4 w-4 rounded border-input"
            />
            <span className="text-sm">
              <span className="font-medium text-foreground">Apply task cooldown</span>
              <span className="block text-muted-foreground mt-0.5">
                Off = workers can claim this task immediately, ignoring the global cooldown setting. Useful for high-priority drops.
              </span>
            </span>
          </label>

          {error && (
            <div className="rounded-lg bg-destructive/10 border border-destructive/20 px-3 py-2.5 text-sm text-destructive">
              {error}
            </div>
          )}
          {success && (
            <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-3 py-2.5 text-sm text-emerald-500">
              ✓ Task #{success.id} created and posted to Discord ({success.title}).
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className={cn(
              "w-full py-2.5 rounded-lg font-semibold text-sm transition-all",
              "bg-primary text-primary-foreground hover:bg-primary/90",
              "disabled:opacity-60 disabled:cursor-not-allowed"
            )}
          >
            {loading ? "Creating…" : "Create Task & Post to Discord"}
          </button>
        </div>
      </form>
    </div>
  );
}

const fieldClass =
  "w-full px-3 py-2.5 rounded-lg bg-background border border-input text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring text-sm";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-foreground mb-1.5">{label}</label>
      {children}
    </div>
  );
}
