# py2Dmol Web README

The py2Dmol web interface is a zero-install 2D structure viewer that runs entirely in your browser. Everything below happens locally—no files are uploaded to a server.

## Getting Started
- Use **Fetch** to pull a structure from the PDB (4-character IDs) or AlphaFold DB (UniProt IDs).
- Use **Load Files** to drag and drop PDB/CIF/ENT files (zip archives are supported) or metadata such as `.json`, `.cst`, `.a3m`, `.fasta`, `.fa`, `.fas`, and `.sto`.
- Enable **Load as Frames** to treat multiple structures as a trajectory, and **Align Frames** to superpose them automatically.
- Use **Load Biounit** when you want the biological assembly from PDB files. Disable **Ignore Ligands** to keep hetero atoms.

## Saving and Restoring Sessions
- The **Save** button exports a `.py2dmol.json` (or `.zip`) state file containing all loaded objects, current colors, selections, MSAs, and contacts.
- Re-load the state file via **Load Files** to resume exactly where you left off.

## Loading MSAs
- **index.html**: Check **Load MSA** before fetching or uploading to associate MSA files with the currently selected structure. MSAs can come from AlphaFold downloads, local A3M/FASTA/STO files, or files bundled in a `.zip`.
- **msa.html**: Use when you only care about MSAs. Fetch by UniProt/PDB ID (converts via PDBe) or upload alignment files directly. The viewer offers MSA/PSSM/Logo modes with interactive filtering (coverage & identity) and export buttons.
- After an MSA is linked to a structure, coverage/identity sliders and entropy coloring update both the molecule and sequence views immediately. All chains sharing the same sequence reuse the filtered entropy values.
- You can also upload an MSA after a structure is already loaded by dropping the file (with **Load MSA** enabled); it will be matched to chains by sequence.

## Loading Contact Restraints (`.cst`)
- Drop or select `.cst` files alongside structures to add residue-residue contacts. Supported formats:
  - `10 58` (zero- or one-based indices are accepted—the viewer uses your numbering directly).
  - `A 10 B 58` (chain ID + residue number).
- If you upload only metadata (MSA/PAE/contacts) with **Load Files**, the app prompts you to attach them to the currently selected object.
- Contacts appear as bright red connections in the 2D view, and they are stored per object. Re-uploading a `.cst` replaces the previous contact set for that object.

## Tips and Troubleshooting
- **Entropy colors look gray**: Make sure an MSA is loaded and that entropy mode is selected. Adjust coverage/identity sliders to ensure enough sequences remain after filtering.
- **Switching objects duplicates MSAs or contacts**: The viewer automatically reuses existing containers. Use **Clear All** before reloading if you want a fresh start.
- **Fetching AlphaFold MSAs**: When providing a 4-character PDB ID, the app resolves it to a UniProt accession via PDBe and then downloads the AlphaFold alignment.
- **Performance**: Keep the canvas within reasonable sizes for instant feedback. The resize handle next to the viewer lets you increase or decrease the drawing area as needed.

Need more help? Visit the [GitHub repository](https://github.com/sokrypton/py2Dmol) for full documentation and issue tracking.

