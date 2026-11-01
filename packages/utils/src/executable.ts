import * as fs from "node:fs";
import { peekFile, peekFileSync } from "./peek-file";

/**
 * Check if a file path exists, is a regular file, and has effective execute permission.
 */
export function isExecutable(filePath: string): boolean {
	try {
		const stat = fs.statSync(filePath);
		if (!stat.isFile()) return false;
		if (process.platform !== "win32") {
			fs.accessSync(filePath, fs.constants.X_OK);
		}
		return true;
	} catch {
		return false;
	}
}

/** Header bytes {@link isNativeExecutableHeader} needs. */
const NATIVE_MAGIC_BYTES = 4;

/** Mach-O thin (32/64-bit, both byte orders) and fat/universal magics. */
const MACH_O_MAGICS = [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe];

/**
 * Whether `header` starts like an ELF, PE, or Mach-O executable rather than a
 * script (shebang, batch file, JS). Used to tell compiled launchers from Node shims.
 */
export function isNativeExecutableHeader(header: Uint8Array): boolean {
	if (header.length < NATIVE_MAGIC_BYTES) return false;
	if (header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46) return true; // \x7fELF
	if (header[0] === 0x4d && header[1] === 0x5a) return true; // MZ (PE)
	const magic = ((header[0] << 24) | (header[1] << 16) | (header[2] << 8) | header[3]) >>> 0;
	return MACH_O_MAGICS.includes(magic);
}

/**
 * Whether `filePath` is a native executable per {@link isNativeExecutableHeader}.
 * Unreadable or missing files are not native.
 */
export async function isNativeExecutable(filePath: string): Promise<boolean> {
	try {
		return await peekFile(filePath, NATIVE_MAGIC_BYTES, isNativeExecutableHeader);
	} catch {
		return false;
	}
}

/** Synchronous {@link isNativeExecutable}. */
export function isNativeExecutableSync(filePath: string): boolean {
	try {
		return peekFileSync(filePath, NATIVE_MAGIC_BYTES, isNativeExecutableHeader);
	} catch {
		return false;
	}
}
