// Small label shown next to a writing item — a category ('Design', 'Audio'…)
// or a source ('LinkedIn', 'Substack').
export type SourceTag = string;

export interface WritingItem {
  id: string;
  title: string;
  excerpt: string;
  date: string; // ISO 8601
  source: SourceTag;
  url: string;
}

export interface Talk {
  id: string;
  title: string;
  date: string; // ISO 8601
  youtubeUrl: string;
  event?: string;
}

export interface Tool {
  id: string;
  name: string;
  thumbnail: string; // path under /public/images/tools or remote URL
  url: string;
  blurb?: string;
}

export interface ProjectLink {
  label: string;
  url: string;
}

export interface Project {
  id: string;
  name: string;
  tagline: string;
  description: string;
  year?: string;
  role?: string;
  links?: ProjectLink[];
  cover: string;
  gallery?: string[]; // image paths
}

export interface GalleryImage {
  id: string; // deep-link slug
  src: string;
  thumb?: string;
  width: number; // intrinsic px — used for aspect ratio before load
  height: number;
  title?: string;
  description?: string;
  projectId?: string;
}

export interface Social {
  id: string;
  label: string;
  handle?: string;
  url: string;
}

export interface About {
  name: string;
  bio: string; // one-sentence, used on the home page
  long: string; // full About text (paragraphs separated by \n\n)
}
