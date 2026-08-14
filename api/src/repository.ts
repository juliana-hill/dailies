import { Firestore } from '@google-cloud/firestore';
import type { Project } from '@dailies/shared';

export interface ProjectRepository {
  create(project: Project): Promise<Project>;
  get(projectId: string): Promise<Project | undefined>;
  listForOwner(ownerId: string): Promise<Project[]>;
  update(projectId: string, mutate: (project: Project) => Project): Promise<Project>;
}

export class MemoryProjectRepository implements ProjectRepository {
  protected projects = new Map<string, Project>();
  async create(project: Project) { this.projects.set(project.projectId, structuredClone(project)); return structuredClone(project); }
  async get(id: string) { const value = this.projects.get(id); return value && structuredClone(value); }
  async listForOwner(ownerId: string) { return [...this.projects.values()].filter((p) => p.ownerId === ownerId).map((project) => structuredClone(project)); }
  async update(id: string, mutate: (project: Project) => Project) {
    const current = this.projects.get(id); if (!current) throw new Error('PROJECT_NOT_FOUND');
    const next = mutate(structuredClone(current)); this.projects.set(id, next); return structuredClone(next);
  }
}

export class FirestoreProjectRepository implements ProjectRepository {
  private readonly collection;
  constructor(projectId: string | undefined, collectionName: string) { this.collection = new Firestore({ projectId, ignoreUndefinedProperties: true }).collection(collectionName); }
  async create(project: Project) { await this.collection.doc(project.projectId).create(project); return structuredClone(project); }
  async get(id: string) { const snapshot = await this.collection.doc(id).get(); return snapshot.exists ? snapshot.data() as Project : undefined; }
  async listForOwner(ownerId: string) { const snapshot = await this.collection.where('ownerId', '==', ownerId).get(); return snapshot.docs.map((doc) => doc.data() as Project).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  async update(id: string, mutate: (project: Project) => Project) {
    const firestore = this.collection.firestore; const reference = this.collection.doc(id);
    return firestore.runTransaction(async (transaction) => { const snapshot = await transaction.get(reference); if (!snapshot.exists) throw new Error('PROJECT_NOT_FOUND'); const next = mutate(snapshot.data() as Project); transaction.set(reference, next); return structuredClone(next); });
  }
}
