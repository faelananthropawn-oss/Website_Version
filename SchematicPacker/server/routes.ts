import type { Express, Request } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import multer from "multer";
import path from "path";
import fs from "fs";
import { z } from "zod";

// Type declaration for commands.mjs
interface CommandsModule {
  loadSchematic(filePath: string): Promise<any>;
  dumpSetblockCommands(schematic: any, outPath: string): Promise<void>;
  buildPack(commandsFile: string, packName: string): Promise<void>;
}

// Store commands functions at module level
let loadSchematic: CommandsModule['loadSchematic'];
let dumpSetblockCommands: CommandsModule['dumpSetblockCommands'];
let buildPack: CommandsModule['buildPack'];
import { incrementVisit, incrementPackCreated, incrementDownload, getStats } from "./counter";

// Extend Express Request interface for multer
interface MulterRequest extends Request {
  file?: Express.Multer.File;
}

// Configure multer for file uploads
const upload = multer({
  dest: "uploads/",
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedExtensions = ['.schem', '.schematic'];
    const fileExtension = path.extname(file.originalname).toLowerCase();
    if (allowedExtensions.includes(fileExtension)) {
      cb(null, true);
    } else {
      cb(new Error('Only .schem and .schematic files are allowed'));
    }
  }
});

// Progress tracking for conversions
const conversionProgress = new Map<string, {
  step: string;
  progress: number;
  error?: string;
}>();

// Track pack files and their cleanup timers
const packCleanupTimers = new Map<string, NodeJS.Timeout>();

// Auto-cleanup undownloaded packs after 1 hour
function schedulePackCleanup(packPath: string, conversionId: string) {
  const timer = setTimeout(() => {
    try {
      if (fs.existsSync(packPath)) {
        fs.unlinkSync(packPath);
        console.log(`Auto-cleaned undownloaded pack: ${packPath}`);
      }
      conversionProgress.delete(conversionId);
      packCleanupTimers.delete(conversionId);
    } catch (error) {
      console.error("Auto-cleanup error:", error);
    }
  }, 60 * 60 * 1000); // 1 hour
  
  packCleanupTimers.set(conversionId, timer);
}

// Cancel scheduled cleanup (when file is downloaded)
function cancelPackCleanup(conversionId: string) {
  const timer = packCleanupTimers.get(conversionId);
  if (timer) {
    clearTimeout(timer);
    packCleanupTimers.delete(conversionId);
    console.log(`Cancelled auto-cleanup for ${conversionId}`);
  }
}

export async function registerRoutes(app: Express): Promise<Server> {
  // Import commands from mjs file
  const commands = await import("./commands.mjs") as CommandsModule;
  loadSchematic = commands.loadSchematic;
  dumpSetblockCommands = commands.dumpSetblockCommands;
  buildPack = commands.buildPack;
  // Ensure uploads directory exists
  const uploadsDir = path.resolve("uploads");
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  // Clean up old pack files on server start
  try {
    const packFiles = fs.readdirSync(".").filter(file => file.endsWith(".mcpack"));
    packFiles.forEach(file => {
      try {
        fs.unlinkSync(file);
        console.log(`Cleaned up old pack file on startup: ${file}`);
      } catch (error) {
        console.error(`Failed to clean up ${file}:`, error);
      }
    });
    if (packFiles.length > 0) {
      console.log(`Startup cleanup: removed ${packFiles.length} old pack files`);
    }
  } catch (error) {
    console.error("Startup cleanup error:", error);
  }

  // Health check endpoint
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Homepage visit tracking
  app.get("/api/visit", (req, res) => {
    const visitCount = incrementVisit();
    res.json({ visitCount });
  });

  // Usage statistics endpoint
  app.get("/api/stats", (req, res) => {
    const stats = getStats();
    res.json(stats);
  });

  // Manual cleanup endpoint for leftover files
  app.post("/api/cleanup", (req, res) => {
    try {
      const uploadsDir = path.resolve("uploads");
      const uploadFiles = fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir) : [];
      const packFiles = fs.readdirSync(".").filter(file => file.endsWith(".mcpack"));
      
      let cleaned = 0;
      
      // Clean uploads folder
      uploadFiles.forEach(file => {
        const filePath = path.join(uploadsDir, file);
        try {
          fs.unlinkSync(filePath);
          cleaned++;
        } catch (error) {
          console.error(`Failed to clean up ${file}:`, error);
        }
      });
      
      // Clean pack files
      packFiles.forEach(file => {
        try {
          fs.unlinkSync(file);
          cleaned++;
        } catch (error) {
          console.error(`Failed to clean up ${file}:`, error);
        }
      });
      
      // Clear all cleanup timers
      packCleanupTimers.clear();
      conversionProgress.clear();
      
      res.json({ 
        message: `Cleaned up ${cleaned} total files (${uploadFiles.length} uploads, ${packFiles.length} packs)` 
      });
    } catch (error) {
      console.error("Cleanup endpoint error:", error);
      res.status(500).json({ message: "Cleanup failed" });
    }
  });

  // Upload schematic file
  app.post("/api/upload", upload.single("schematic"), async (req: MulterRequest, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }

      // Validate file extension
      const fileExtension = path.extname(req.file.originalname).toLowerCase();
      if (!['.schem', '.schematic'].includes(fileExtension)) {
        // Clean up uploaded file
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ message: "Invalid file type. Only .schem and .schematic files are supported." });
      }

      // Create conversion record
      const conversion = await storage.createConversion({
        filename: req.file.originalname,
        originalSize: `${(req.file.size / 1024 / 1024).toFixed(2)} MB`,
      });

      // Initialize progress tracking
      conversionProgress.set(conversion.id, {
        step: "File uploaded successfully",
        progress: 10,
      });

      res.json({
        conversionId: conversion.id,
        filename: req.file.originalname,
        size: req.file.size,
        path: req.file.path,
      });
    } catch (error) {
      // Clean up file if upload failed
      if (req.file?.path && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      
      console.error("Upload error:", error);
      res.status(500).json({ 
        message: error instanceof Error ? error.message : "Upload failed" 
      });
    }
  });

  // Start conversion process
  app.post("/api/convert/:conversionId", async (req, res) => {
    try {
      const { conversionId } = req.params;
      const { filePath, packName } = req.body;

      const conversionSchema = z.object({
        filePath: z.string(),
        packName: z.string().min(1).max(50),
      });

      const validated = conversionSchema.parse({ filePath, packName });

      if (!fs.existsSync(validated.filePath)) {
        return res.status(404).json({ message: "Uploaded file not found" });
      }

      // Store the pack name and start async conversion process
      await storage.updateConversion(conversionId, { packName: validated.packName });
      processSchematic(conversionId, validated.filePath, validated.packName);

      res.json({ message: "Conversion started", conversionId });
    } catch (error) {
      console.error("Conversion start error:", error);
      
      // Update progress with error
      conversionProgress.set(req.params.conversionId, {
        step: "Conversion failed to start",
        progress: 0,
        error: error instanceof Error ? error.message : "Failed to start conversion",
      });

      res.status(500).json({ 
        message: error instanceof Error ? error.message : "Failed to start conversion" 
      });
    }
  });

  // Get conversion progress
  app.get("/api/progress/:conversionId", (req, res) => {
    const { conversionId } = req.params;
    const progress = conversionProgress.get(conversionId);
    
    if (!progress) {
      return res.status(404).json({ message: "Conversion not found" });
    }

    res.json(progress);
  });

  // Download converted file
  app.get("/api/download/:conversionId", async (req, res) => {
    try {
      const { conversionId } = req.params;
      const conversion = await storage.getConversion(conversionId);

      if (!conversion) {
        return res.status(404).json({ message: "Conversion not found" });
      }

      if (conversion.status !== "completed") {
        return res.status(400).json({ message: "Conversion not completed" });
      }

      // Use the stored pack name to match what buildPack creates
      const storedPackName = conversion.packName || conversion.filename.replace(/\.(schem|schematic)$/i, '');
      const sanitizedPackName = storedPackName.replace(/[^\w\s-]/g, '').replace(/\s+/g, '_');
      const packPath = path.resolve(`${sanitizedPackName}.mcpack`);
      
      
      if (!fs.existsSync(packPath)) {
        return res.status(404).json({ message: "Generated pack file not found" });
      }

      const downloadFilename = path.basename(packPath);
      res.setHeader('Content-Disposition', `attachment; filename="${downloadFilename}"`);
      res.setHeader('Content-Type', 'application/zip');
      
      // Cancel auto-cleanup since file is being downloaded
      cancelPackCleanup(conversionId);
      
      // Increment download counter
      incrementDownload();
      
      const fileStream = fs.createReadStream(packPath);
      fileStream.pipe(res);
      
      // Clean up after download completes
      fileStream.on('end', () => {
        try {
          fs.unlinkSync(packPath);
          conversionProgress.delete(conversionId);
          console.log(`Cleaned up pack file after download: ${packPath}`);
        } catch (error) {
          console.error("Pack cleanup error:", error);
        }
      });
      
      // Also clean up if there's an error
      fileStream.on('error', () => {
        try {
          fs.unlinkSync(packPath);
          conversionProgress.delete(conversionId);
        } catch (error) {
          console.error("Pack cleanup error on stream error:", error);
        }
      });

    } catch (error) {
      console.error("Download error:", error);
      res.status(500).json({ 
        message: error instanceof Error ? error.message : "Download failed" 
      });
    }
  });

  const httpServer = createServer(app);

  return httpServer;
}

// Async function to process schematic conversion
async function processSchematic(conversionId: string, filePath: string, packName: string) {
  try {
    // Update progress: Reading schematic
    conversionProgress.set(conversionId, {
      step: "Reading schematic format",
      progress: 20,
    });

    const schematic = await loadSchematic(filePath);

    // Update progress: Parsing NBT data
    conversionProgress.set(conversionId, {
      step: "Parsing NBT data",
      progress: 40,
    });

    await new Promise(resolve => setTimeout(resolve, 500)); // Small delay for UX

    // Update progress: Converting blocks
    conversionProgress.set(conversionId, {
      step: "Converting block palette",
      progress: 60,
    });

    const commandsFile = `${filePath}.setblock.txt`;
    await dumpSetblockCommands(schematic, commandsFile);

    // Update progress: Building pack
    conversionProgress.set(conversionId, {
      step: "Generating Bedrock structure",
      progress: 80,
    });

    await new Promise(resolve => setTimeout(resolve, 500)); // Small delay for UX

    // Update progress: Creating mcpack
    conversionProgress.set(conversionId, {
      step: "Creating Mcpack file",
      progress: 90,
    });

    await buildPack(commandsFile, packName);

    // Increment pack created counter
    incrementPackCreated();

    // Update progress: Complete
    conversionProgress.set(conversionId, {
      step: "Conversion complete",
      progress: 100,
    });

    // Update database
    await storage.updateConversion(conversionId, {
      status: "completed",
      completedAt: new Date(),
    });

    // Schedule auto-cleanup for the pack file if not downloaded
    const sanitizedPackName = packName.replace(/[^\w\s-]/g, '').replace(/\s+/g, '_');
    const packPath = path.resolve(`${sanitizedPackName}.mcpack`);
    schedulePackCleanup(packPath, conversionId);

    // Clean up uploaded file immediately after conversion
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`Cleaned up uploaded file: ${filePath}`);
      }
      // Also clean up any remaining command files
      if (fs.existsSync(commandsFile)) {
        fs.unlinkSync(commandsFile);
        console.log(`Cleaned up command file: ${commandsFile}`);
      }
    } catch (error) {
      console.error("File cleanup error:", error);
    }

  } catch (error) {
    console.error("Processing error:", error);
    
    // Update progress with error
    conversionProgress.set(conversionId, {
      step: "Conversion failed",
      progress: 0,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    });

    // Update database
    await storage.updateConversion(conversionId, {
      status: "failed",
      errorMessage: error instanceof Error ? error.message : "Unknown error occurred",
    });

    // Clean up files on error
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`Cleaned up uploaded file after error: ${filePath}`);
      }
      // Also try to clean up command file if it exists
      const commandsFile = `${filePath}.setblock.txt`;
      if (fs.existsSync(commandsFile)) {
        fs.unlinkSync(commandsFile);
        console.log(`Cleaned up command file after error: ${commandsFile}`);
      }
    } catch (cleanupError) {
      console.error("Cleanup error:", cleanupError);
    }
  }
}
