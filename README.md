# Ironclad Watch Desktop Engine

A lightweight, transparent desktop widget built with Rust and Tauri. This project encapsulates a highly detailed Vanilla JS and CSS watch rendering engine into a frameless, natively draggable OS overlay.

## Overview
* **Frameless UI:** Fully transparent, decoration-free window acting as a native desktop widget.
* **Native Dragging:** OS-level integration for seamless drag-and-drop movement via Tauri API.
* **Multi-Caliber Engine:** Renders multiple watch faces (Quartz, Automatic, Digital, Tuning Fork) using pure CSS, clip-paths, and DOM manipulation.
* **Audio Synthesizer:** Built-in Web Audio API integration for classic digital alarms and hourly chimes.

## Prerequisites
Ensure you have the following installed on your system:
1. [Rust & Cargo](https://www.rust-lang.org/tools/install)
2. Tauri CLI (installed globally):
   ```bash
   cargo install tauri-cli --version "^1.5"

## Project Structure
/frontend/: Contains the isolated web environment (HTML, CSS, Vanilla JS engine). This is the rendering layer.

/src-tauri/: Contains the Rust binary core, the build.rs script, and the critical tauri.conf.json that defines the transparent widget behavior.

# Dev mode 
CLI: cargo tauri dev