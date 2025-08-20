import { type User, type InsertUser, type Conversion, type InsertConversion } from "@shared/schema";
import { randomUUID } from "crypto";

// modify the interface with any CRUD methods
// you might need

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  createConversion(conversion: InsertConversion): Promise<Conversion>;
  getConversion(id: string): Promise<Conversion | undefined>;
  updateConversion(id: string, updates: Partial<Conversion>): Promise<Conversion | undefined>;
}

export class MemStorage implements IStorage {
  private users: Map<string, User>;
  private conversions: Map<string, Conversion>;

  constructor() {
    this.users = new Map();
    this.conversions = new Map();
  }

  async getUser(id: string): Promise<User | undefined> {
    return this.users.get(id);
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(
      (user) => user.username === username,
    );
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const id = randomUUID();
    const user: User = { ...insertUser, id };
    this.users.set(id, user);
    return user;
  }

  async createConversion(insertConversion: InsertConversion): Promise<Conversion> {
    const id = randomUUID();
    const conversion: Conversion = {
      ...insertConversion,
      id,
      status: "processing",
      errorMessage: null,
      createdAt: new Date(),
      completedAt: null,
      outputSize: null,
      originalSize: insertConversion.originalSize || null,
    };
    this.conversions.set(id, conversion);
    return conversion;
  }

  async getConversion(id: string): Promise<Conversion | undefined> {
    return this.conversions.get(id);
  }

  async updateConversion(id: string, updates: Partial<Conversion>): Promise<Conversion | undefined> {
    const existing = this.conversions.get(id);
    if (!existing) return undefined;

    const updated = { ...existing, ...updates };
    this.conversions.set(id, updated);
    return updated;
  }
}

export const storage = new MemStorage();
