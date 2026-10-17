import path from 'node:path';

export function loadConfig(env = process.env) {
  return {
    host: env.BENCHMARK_HOST || '127.0.0.1',
    port: Number(env.BENCHMARK_PORT || 8788),
    accessToken: env.BENCHMARK_ACCESS_TOKEN || '',
    dataDir: path.resolve(env.BENCHMARK_DATA_DIR || './var/router-bench'),
    terminalBenchDir: path.resolve(env.TERMINAL_BENCH_DIR || './terminal-bench'),
    harborBin: env.HARBOR_BIN || 'harbor',
    pythonBin: env.PYTHON_BIN || 'python3',
    maxActiveRuns: Number(env.BENCHMARK_MAX_ACTIVE_RUNS || 1),
  };
}

