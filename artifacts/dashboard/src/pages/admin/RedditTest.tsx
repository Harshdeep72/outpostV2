import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { post } from "@/lib/api";
import { cn } from "@/lib/utils";

interface RedditTestResult {
  valid: boolean;
  author: string | null;
  subreddit: string | null;
  title: string | null;
  error: string | null;
}

export default function RedditTest() {
  const [url, setUrl] = useState("");
  const [expectedAuthor, setExpectedAuthor] = useState("");
  const [expectedSubreddit, setExpectedSubreddit] = useState("");

  const mutation = useMutation({
    mutationFn: () =>
      post<RedditTestResult>("/admin/reddit-test", {
        url,
        expectedAuthor: expectedAuthor || undefined,
        expectedSubreddit: expectedSubreddit || undefined,
      }),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (url) mutation.mutate();
  };

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      <div>
        <h1 className="text-xl font-bold text-foreground">Reddit URL Test</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Validate a Reddit post URL — checks if it exists, who authored it, and which subreddit
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="rounded-xl border border-border bg-card p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">Reddit Post URL</label>
            <input
              type="url"
              value={url}
              onChange={e => setUrl(e.target.value)}
              placeholder="https://reddit.com/r/subreddit/comments/..."
              required
              className="w-full px-3 py-2.5 rounded-lg bg-background border border-input text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-foreground mb-1.5">
                Expected Author
                <span className="text-muted-foreground font-normal ml-1">(optional)</span>
              </label>
              <input
                type="text"
                value={expectedAuthor}
                onChange={e => setExpectedAuthor(e.target.value)}
                placeholder="u/username"
                className="w-full px-3 py-2.5 rounded-lg bg-background border border-input text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground mb-1.5">
                Expected Subreddit
                <span className="text-muted-foreground font-normal ml-1">(optional)</span>
              </label>
              <input
                type="text"
                value={expectedSubreddit}
                onChange={e => setExpectedSubreddit(e.target.value)}
                placeholder="r/subreddit"
                className="w-full px-3 py-2.5 rounded-lg bg-background border border-input text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>
          <button
            type="submit"
            disabled={mutation.isPending || !url}
            className={cn(
              "px-5 py-2.5 rounded-lg font-semibold text-sm transition-all",
              "bg-primary text-primary-foreground hover:bg-primary/90",
              "disabled:opacity-60 disabled:cursor-not-allowed"
            )}
          >
            {mutation.isPending ? "Testing..." : "Test URL"}
          </button>
        </div>
      </form>

      {mutation.data && (
        <div className={cn(
          "rounded-xl border p-5 space-y-4",
          mutation.data.valid
            ? "border-green-500/20 bg-green-500/5"
            : "border-destructive/20 bg-destructive/5"
        )}>
          <div className="flex items-center gap-2">
            <div className={cn(
              "w-8 h-8 rounded-full flex items-center justify-center",
              mutation.data.valid ? "bg-green-500/20" : "bg-destructive/20"
            )}>
              {mutation.data.valid ? (
                <svg className="w-4 h-4 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                <svg className="w-4 h-4 text-destructive" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              )}
            </div>
            <span className={cn("font-semibold text-sm", mutation.data.valid ? "text-green-400" : "text-destructive")}>
              {mutation.data.valid ? "Valid post" : "Invalid / failed check"}
            </span>
          </div>

          {mutation.data.error && (
            <div className="text-sm text-destructive bg-destructive/10 rounded-lg px-3 py-2">
              {mutation.data.error}
            </div>
          )}

          {mutation.data.title && (
            <div className="grid grid-cols-1 gap-2 text-sm">
              {[
                ["Title", mutation.data.title],
                ["Author", mutation.data.author ? `u/${mutation.data.author}` : "—"],
                ["Subreddit", mutation.data.subreddit ? `r/${mutation.data.subreddit}` : "—"],
              ].map(([label, value]) => (
                <div key={label} className="flex items-start gap-2">
                  <span className="text-muted-foreground min-w-[80px] shrink-0">{label}:</span>
                  <span className="text-foreground font-medium">{value}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {mutation.isError && (
        <div className="rounded-xl border border-destructive/20 bg-destructive/5 p-4 text-sm text-destructive">
          {(mutation.error as Error)?.message ?? "Request failed"}
        </div>
      )}
    </div>
  );
}
