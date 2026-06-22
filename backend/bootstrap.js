import "dotenv/config";
import fs from "fs";
import { Readable } from "stream";
import { finished } from "stream/promises";
import AdmZip from "adm-zip";

const DB_URL = process.env.DB_URL;
const DB_ARCHIVE = "./data/db.zip"; // Renamed for clarity
const DB_DIR = "./data/mydb.lance";

async function setup() {
  console.log("=== Bootstrap starting ===");

  if (fs.existsSync(DB_ARCHIVE)) {
    console.log(`Database already exists at ${DB_ARCHIVE}`);
  } else {
    console.log("Database not found.");
    console.log(`Downloading from ${DB_URL}`);

    const response = await fetch(DB_URL);
    console.log(`HTTP status: ${response.status}`);

    if (!response.ok) {
      throw new Error(`Download failed: ${response.status}`);
    }

    fs.mkdirSync("./data", { recursive: true });

    // Stream download to avoid out-of-memory errors
    const fileStream = fs.createWriteStream(DB_ARCHIVE);
    const downloadStream = Readable.fromWeb(response.body);

    console.log("Streaming download directly to disk...");
    downloadStream.pipe(fileStream);
    await finished(fileStream);

    console.log("Extracting archive using adm-zip...");

    // 2. Extract using pure JS (No OS dependencies required)
    try {
      const zip = new AdmZip(DB_ARCHIVE);
      zip.extractAllTo("./data", /*overwrite*/ true);
      console.log("Extraction complete.");
    } catch (extractErr) {
      throw new Error(`Extraction failed: ${extractErr.message}`);
    }

    // Optional: clean up the zip file afterward to save disk space
    // try {
    //   fs.unlinkSync(DB_ARCHIVE);
    // } catch (e) {
    //   // ignore cleanup errors
    // }

    console.log("Contents of ./data:");
    console.log(fs.readdirSync("./data"));
  }

  console.log("Starting application...");
  await import("./src/index.js");
}

setup().catch((err) => {
  console.error("BOOTSTRAP FAILED");
  console.error(err);
});
