import fs from "fs";
import path from "path";

const COUNTER_FILE = path.resolve("usage-stats.txt");

interface UsageStats {
  visits: number;
  packsCreated: number;
  downloads: number;
}

function readStats(): UsageStats {
  try {
    if (fs.existsSync(COUNTER_FILE)) {
      const data = fs.readFileSync(COUNTER_FILE, "utf8");
      return JSON.parse(data);
    }
  } catch (error) {
    console.warn("Error reading stats file:", error);
  }
  
  return { visits: 0, packsCreated: 0, downloads: 0 };
}

function writeStats(stats: UsageStats): void {
  try {
    fs.writeFileSync(COUNTER_FILE, JSON.stringify(stats, null, 2));
  } catch (error) {
    console.error("Error writing stats file:", error);
  }
}

export function incrementVisit(): number {
  const stats = readStats();
  stats.visits++;
  writeStats(stats);
  return stats.visits;
}

export function incrementPackCreated(): number {
  const stats = readStats();
  stats.packsCreated++;
  writeStats(stats);
  return stats.packsCreated;
}

export function incrementDownload(): number {
  const stats = readStats();
  stats.downloads++;
  writeStats(stats);
  return stats.downloads;
}

export function getStats(): UsageStats {
  return readStats();
}