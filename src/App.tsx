import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";

const queryClient = new QueryClient();

function DiffView() {
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
        <FileDiff
          key={fileDiff.name ?? i}
          fileDiff={fileDiff}
          options={{
            theme: "github-dark",
            diffStyle: "unified",
          }}
        />
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
