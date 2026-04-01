import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";

const queryClient = new QueryClient();

const wideQuery = "(min-width: 1200px)";

function useIsWide(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mql = window.matchMedia(wideQuery);
      mql.addEventListener("change", cb);
      return () => mql.removeEventListener("change", cb);
    },
    () => window.matchMedia(wideQuery).matches,
  );
}

function DiffView() {
  const isWide = useIsWide();
  const { data, error, isLoading } = useQuery({
    queryKey: ["diff"],
    queryFn: () => fetch("/api/diff").then((r) => r.json()),
  });

  if (isLoading) return <div style={{ padding: 20 }}>Loading...</div>;
  if (error) return <pre style={{ color: "red", padding: 20 }}>{String(error)}</pre>;
  if (data.error) return <pre style={{ color: "red", padding: 20 }}>{data.error}</pre>;
  if (!data.patch) return <div style={{ padding: 20 }}>No changes in {data.revset}</div>;

  const patches = parsePatchFiles(data.patch);
  const files = patches.flatMap((p) => p.files);

  return (
    <div>
      {files.map((fileDiff, i) => (
        <div key={fileDiff.name ?? i}>
          {i > 0 && <div className="file-gap" />}
          <FileDiff
            fileDiff={fileDiff}
            options={{
              theme: "github-dark-default",
              diffStyle: isWide ? "split" : "unified",
              diffIndicators: "bars",
              overflow: "wrap",
              unsafeCSS: `[data-diffs-header] { position: sticky; top: 0; z-index: 10; }`,
            }}
          />
        </div>
      ))}
    </div>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <DiffView />
    </QueryClientProvider>
  );
}
