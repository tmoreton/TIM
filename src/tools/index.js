import { listFiles, readFile, editFile, writeFile } from "./fs.js";
import { bash } from "./bash.js";
import { grep, glob } from "./search.js";

export const tools = {
  list_files: listFiles,
  read_file: readFile,
  edit_file: editFile,
  write_file: writeFile,
  bash,
  grep,
  glob,
};

export const toolSchemas = Object.values(tools).map((t) => t.schema);
