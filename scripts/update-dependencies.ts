import { updatePackageDependencies } from "@/dependency-update";

const result = await updatePackageDependencies();
if (result.changes.length === 0) {
  console.log("Package dependencies are already up to date.");
} else {
  console.log(`Updated ${result.changes.length} package dependencies:`);
  for (const change of result.changes) {
    console.log(`- ${change.name} (${change.section}): ${change.from} -> ${change.to}`);
  }
}

export {};
