export interface User { id: string; email: string; name: string; google_sub: string | null; role: 'user' | 'admin'; active: number }
export interface Resource {
 id: string; source_system: string | null; source_id: string | null; title: string; description: string;
 creator_id: string; registered_by: string | null; department_id: string | null; kind: 'document' | 'tool' | null;
 event: string | null; edition: string | null; event_scope_id:string|null; event_scope_name?:string|null; tags: string; url: string | null;
 status: 'draft' | 'published' | 'archived'; visibility: 'company' | 'private';
 access_request: number; publisher_slack_id: string | null; preview_blob: string | null; html_blob: string | null;
 original_filename: string | null; source_metadata: string; version: number; created_at: string; updated_at: string;
 creator_name?: string; creator_email?: string; department_name?: string; is_saved?: number;
 categories?: string;
}
export interface Config {
 origin: string; localDev: boolean; dataDir: string; adminEmail: string; allowedDomains: string[];
 googleClientId?: string; googleClientSecret?: string; newsFeeds: string[];
}
export const now = () => new Date().toISOString();
export const epoch = () => Math.floor(Date.now() / 1000);
export const canRead = (r: Resource, u: User) => u.role === 'admin' || r.creator_id === u.id || (r.status === 'published' && r.visibility === 'company');
export const canEdit = (r: Resource, u: User) => u.role === 'admin' || r.creator_id === u.id;
