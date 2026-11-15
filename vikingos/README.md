# Sistema Vikingos Licor Store

Programa de facturación, inventario y créditos de **Vikingos Licor Store** (versión de escritorio).

Este directorio contiene **solo el programa**: ningún dato de ventas, clientes ni usuarios.
Las computadoras con el sistema instalado revisan `vikingos/version.json` cada hora y,
si hay una versión nueva, descargan los archivos de `vikingos/programa/`, verifican su
huella SHA-256 y se actualizan solas cuando no hay ventas en curso.

Los datos de la tienda se sincronizan entre computadoras por un repositorio **privado** aparte.
