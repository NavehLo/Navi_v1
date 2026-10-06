import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The climate grid, the regions and the landscape are read with fs at run
  // time, which the build's file tracing cannot see on its own (see
  // src/lib/climateGrid.ts, src/lib/regions.ts and src/lib/landscapeData.ts).
  outputFileTracingIncludes: {
    "/api/climate": ["./src/data/climate-grid.bin.gz"],
    "/api/world-trails/by-country": ["./src/data/climate-grid.bin.gz", "./src/data/regions.json.gz", "./src/data/trail-landscape.json.gz"],
    "/api/landscape": ["./src/data/landscape.json.gz", "./src/data/trail-landscape.json.gz"],
    // Both may build a country's list first (countryTrails), like by-country.
    "/api/world-trails/leaders": ["./src/data/climate-grid.bin.gz", "./src/data/regions.json.gz"],
    "/api/world-trails/ranking": ["./src/data/climate-grid.bin.gz", "./src/data/regions.json.gz", "./src/data/trail-landscape.json.gz"],
  },
};

export default nextConfig;
