import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The climate grid and the regions are read with fs at run time, which the
  // build's file tracing cannot see on its own (see src/lib/climateGrid.ts and
  // src/lib/regions.ts).
  outputFileTracingIncludes: {
    "/api/climate": ["./src/data/climate-grid.bin.gz"],
    "/api/world-trails/by-country": ["./src/data/climate-grid.bin.gz", "./src/data/regions.json.gz"],
  },
};

export default nextConfig;
