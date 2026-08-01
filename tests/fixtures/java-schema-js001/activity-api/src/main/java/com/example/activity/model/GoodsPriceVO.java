package com.example.activity.model;

import java.math.BigDecimal;

public record GoodsPriceVO(BigDecimal amount, CurrencyCode currency) {}
