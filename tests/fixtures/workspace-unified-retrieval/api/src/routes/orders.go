package routes

import "net/http"

func createOrder(w http.ResponseWriter, r *http.Request) {}

func RegisterOrderRoutes() {
	http.HandleFunc("/orders", createOrder)
}
