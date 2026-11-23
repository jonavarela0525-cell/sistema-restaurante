# Sistema del Restaurante

Programa de facturación, comandas e inventario de **La Casa de la Birria**.

Este repositorio contiene **solo el programa** (sin datos de ventas ni clientes).
Las computadoras con el sistema instalado revisan `version.json` cada hora y,
si hay una versión nueva, descargan los archivos de `programa/`, verifican que
lleguen completos y se actualizan solas cuando no hay mesas abiertas.

- `version.json`: versión publicada y lista de archivos con su huella SHA-256.
- `programa/`: archivos del sistema.

La carpeta `vikingos/` contiene el sistema de **Vikingos Licor Store**, con su propio `version.json`.

La carpeta `finanzas/` contiene **Mis Finanzas** (control personal del dueño), con su propio `version.json`.
