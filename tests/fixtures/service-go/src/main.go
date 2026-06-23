package main

import "net/http"

func main() {
	router := gin.Default()
	router.GET("/api/go/users", nil)
	http.Get("/api/go/orders")
	http.Get(buildURL())
	local.Get("/api/go/local-cache")
}
