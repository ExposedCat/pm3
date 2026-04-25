import type { Project } from "../../database/projects.ts";

export function printProject(project: Project): void {
  console.log(`name: ${project.name}`);
  console.log(`id: ${project.id}`);
  console.log(`workdir: ${project.workingDir}`);
}
